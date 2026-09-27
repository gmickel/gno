/**
 * Existence-only classification of unresolved workspace wiki links and
 * relative Markdown links whose target is a file inside the link workspace
 * that is not an indexed document (an attachment, a script beside a note, or
 * a note in an unindexed or excluded folder). Obsidian
 * resolves such links, so the link audit reports them as `outside-index`
 * instead of unresolved. Only file names are listed: no file is opened,
 * indexed, or returned, and no graph edge is created.
 *
 * @module src/core/audit-outside-index
 */

import type { Database } from "bun:sqlite";

// node:fs/promises readdir/realpath/stat: directory enumeration and symlink
// resolution; Bun has no equivalent that can skip an unreadable folder
// instead of failing the scan.
import { readdir, realpath, stat } from "node:fs/promises";
// node:path join: platform path algebra; no Bun equivalent.
import { join } from "node:path";

import type {
  AuditLinkSnapshot,
  AuditLinkSnapshotLink,
} from "../store/sqlite/graph-link-resolver";

import {
  createWorkspaceFileMatcher,
  loadLinkWorkspaceMemberships,
} from "../store/sqlite/workspace-link-resolver";
import { pathContains, placeDocument } from "./link-workspace";

/** Path identity for exact-path matching: NFC, case-insensitive. */
const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();

/**
 * A Markdown link names the file's exact path; as with wiki links, `.md` is
 * optional, so `[x](Note)` matches an unindexed `Note.md`. An indexed
 * `Note.md` is not outside the index, so that link keeps its status. Indexed
 * paths are compared under the same key as listed files (NFC, Unicode
 * lowercase), never SQLite's ASCII-only NOCASE.
 */
const markdownTargetExists = (
  link: AuditLinkSnapshotLink,
  targetPath: string,
  paths: ReadonlySet<string> | undefined,
  indexedKeys: (collection: string) => ReadonlySet<string>
): boolean => {
  const key = pathKey(targetPath);
  if (paths?.has(key) === true) return true;
  if (key.endsWith(".md") || paths?.has(`${key}.md`) !== true) return false;
  return !indexedKeys(link.targetCollection).has(
    pathKey(`${link.targetRefNorm}.md`)
  );
};

/** Upper bound of files listed per workspace; beyond it the listing is partial. */
export const WORKSPACE_FILE_LISTING_MAX_FILES = 200_000;

export interface WorkspaceFileListing {
  /** Workspace-relative POSIX paths (NFC) of every non-hidden file. */
  files: string[];
  /** False when a folder could not be read or the file bound was reached. */
  complete: boolean;
}

interface WorkspaceDirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Filesystem reads the listing needs; injectable for tests. */
export interface WorkspaceFileSystem {
  readDirectory(path: string): Promise<WorkspaceDirectoryEntry[]>;
  realPath(path: string): Promise<string>;
  isRegularFile(path: string): Promise<boolean>;
}

const nodeWorkspaceFileSystem: WorkspaceFileSystem = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  realPath: (path) => realpath(path),
  isRegularFile: async (path) => (await stat(path)).isFile(),
};

/** A symlink target that does not exist (or loops) is not a file, not an error. */
const MISSING_TARGET_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/**
 * A symlink counts as a file only when it resolves to an existing regular
 * file inside the workspace. Dangling links, links to folders and links that
 * leave the workspace are not files. Other errors are reported as such.
 */
const symlinkIsWorkspaceFile = async (
  fs: WorkspaceFileSystem,
  realRoot: string,
  path: string
): Promise<"file" | "not-file" | "error"> => {
  try {
    const target = await fs.realPath(path);
    if (!pathContains(realRoot, target)) return "not-file";
    return (await fs.isRegularFile(target)) ? "file" : "not-file";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return code !== undefined && MISSING_TARGET_CODES.has(code)
      ? "not-file"
      : "error";
  }
};

/**
 * List every file below a workspace root once. Hidden files and folders
 * (`.obsidian`, `.trash`, `.git`) are skipped, as Obsidian does; symlinked
 * folders are not descended. Filesystem calls use the names as stored on
 * disk; only the returned paths are NFC-normalized for matching. An
 * unreadable folder is skipped and marks the listing incomplete, so links
 * into it stay unresolved.
 */
export const listWorkspaceFiles = async (
  root: string,
  options: {
    maxFiles?: number;
    signal?: AbortSignal;
    fileSystem?: WorkspaceFileSystem;
  } = {}
): Promise<WorkspaceFileListing> => {
  const maxFiles = options.maxFiles ?? WORKSPACE_FILE_LISTING_MAX_FILES;
  const fs = options.fileSystem ?? nodeWorkspaceFileSystem;
  const files: string[] = [];
  let complete = true;
  let realRoot: string;
  try {
    realRoot = await fs.realPath(root);
  } catch {
    return { files, complete: false };
  }
  // Each folder keeps its on-disk segments; matching uses the NFC path.
  const queue: string[][] = [[]];
  for (let head = 0; head < queue.length; head += 1) {
    options.signal?.throwIfAborted();
    const segments = queue[head] as string[];
    let entries;
    try {
      entries = await fs.readDirectory(join(root, ...segments));
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entrySegments = [...segments, entry.name];
      let isFile = entry.isFile();
      if (entry.isDirectory()) {
        queue.push(entrySegments);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const kind = await symlinkIsWorkspaceFile(
          fs,
          realRoot,
          join(root, ...entrySegments)
        );
        if (kind === "error") complete = false;
        isFile = kind === "file";
      }
      if (!isFile) continue;
      if (files.length >= maxFiles) return { files, complete: false };
      files.push(entrySegments.join("/").normalize("NFC"));
    }
  }
  return { files, complete };
};

/**
 * Mark unresolved plain wiki links and relative Markdown links of audited
 * documents inside a link workspace whose target exists as a workspace file.
 * A wiki link matches under workspace resolution rules; a Markdown link must
 * name the file's exact path (NFC, case-insensitive), `.md` optional. Each involved workspace
 * is listed once per call. A failed or partial listing never marks a link
 * that is not in it; the snapshot then carries one diagnostic.
 */
export const markOutsideIndexLinks = async (
  db: Database,
  snapshot: AuditLinkSnapshot,
  options: { maxFiles?: number; signal?: AbortSignal } = {}
): Promise<AuditLinkSnapshot> => {
  const audited = snapshot.auditedDocumentIds
    ? new Set(snapshot.auditedDocumentIds)
    : null;
  const candidates = snapshot.links
    .map((link, index) => ({ link, index }))
    .filter(
      ({ link }) =>
        link.resolved === null &&
        (link.linkType === "markdown" ||
          (link.linkType === "wiki" && link.explicitCollection !== true)) &&
        (audited === null || audited.has(link.sourceId))
    );
  if (candidates.length === 0) return snapshot;
  const memberships = loadLinkWorkspaceMemberships(db);
  const documentRelPaths = new Map(
    snapshot.documents.map((document) => [document.id, document.relPath])
  );
  type PlacedLink = {
    link: AuditLinkSnapshot["links"][number];
    index: number;
    key: string;
  } & ({ sourcePath: string } | { targetPath: string });
  const placed = candidates.flatMap(({ link, index }): PlacedLink[] => {
    const membership = memberships.get(link.sourceCollection);
    const placement = placeDocument(
      membership,
      documentRelPaths.get(link.sourceId) ?? link.sourceRelPath
    );
    if (placement.key === null) return [];
    if (link.linkType === "wiki") {
      return [{ link, index, key: placement.key, sourcePath: placement.path }];
    }
    // A Markdown target is stored collection-relative; place it the same way.
    const target = placeDocument(membership, link.targetRefNorm);
    return target.key === placement.key
      ? [{ link, index, key: placement.key, targetPath: target.path }]
      : [];
  });
  if (placed.length === 0) return snapshot;
  const listings = new Map<
    string,
    {
      matches: ReturnType<typeof createWorkspaceFileMatcher>;
      paths: Set<string>;
    }
  >();
  const maxFiles = options.maxFiles ?? WORKSPACE_FILE_LISTING_MAX_FILES;
  let incomplete = 0;
  for (const key of new Set(placed.map((entry) => entry.key))) {
    const listing = await listWorkspaceFiles(key, {
      maxFiles,
      signal: options.signal,
    });
    if (!listing.complete) incomplete += 1;
    listings.set(key, {
      matches: createWorkspaceFileMatcher(listing.files),
      paths: new Set(listing.files.map(pathKey)),
    });
  }
  const indexedByCollection = new Map<string, Set<string>>();
  const indexedKeys = (collection: string): ReadonlySet<string> => {
    let keys = indexedByCollection.get(collection);
    if (!keys) {
      keys = new Set(
        db
          .query<{ relPath: string }, [string]>(
            "SELECT rel_path AS relPath FROM documents WHERE active = 1 AND collection = ?"
          )
          .all(collection)
          .map(({ relPath }) => pathKey(relPath))
      );
      indexedByCollection.set(collection, keys);
    }
    return keys;
  };
  const links = [...snapshot.links];
  for (const entry of placed) {
    const listing = listings.get(entry.key);
    const exists =
      "targetPath" in entry
        ? markdownTargetExists(
            entry.link,
            entry.targetPath,
            listing?.paths,
            indexedKeys
          )
        : listing?.matches(entry.link.targetRefNorm, entry.sourcePath) === true;
    if (exists) {
      links[entry.index] = { ...entry.link, outsideIndex: true };
    }
  }
  return {
    ...snapshot,
    links,
    ...(incomplete > 0
      ? {
          outsideIndexDiagnostic: `The file listing of ${incomplete} link workspace${incomplete === 1 ? " was" : "s were"} incomplete (an unreadable folder or link, or more than ${maxFiles} files); links to files it missed stay unresolved`,
        }
      : {}),
  };
};
