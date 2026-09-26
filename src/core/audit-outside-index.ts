/**
 * Existence-only classification of unresolved workspace wiki links whose
 * target is a file inside the link workspace that is not an indexed document
 * (an attachment, or a note in an unindexed or excluded folder). Obsidian
 * resolves such links, so the link audit reports them as `outside-index`
 * instead of unresolved. Only file names are listed: no file is opened,
 * indexed, or returned, and no graph edge is created.
 *
 * @module src/core/audit-outside-index
 */

import type { Database } from "bun:sqlite";

// node:fs/promises readdir: directory enumeration with file types; Bun has no
// equivalent that can skip an unreadable folder instead of failing the scan.
import { readdir } from "node:fs/promises";
// node:path join: platform path algebra; no Bun equivalent.
import { join } from "node:path";

import type { AuditLinkSnapshot } from "../store/sqlite/graph-link-resolver";

import {
  createWorkspaceFileMatcher,
  loadLinkWorkspaceMemberships,
} from "../store/sqlite/workspace-link-resolver";
import { placeDocument } from "./link-workspace";

/** Upper bound of files listed per workspace; beyond it the listing is partial. */
export const WORKSPACE_FILE_LISTING_MAX_FILES = 200_000;

export interface WorkspaceFileListing {
  /** Workspace-relative POSIX paths (NFC) of every non-hidden file. */
  files: string[];
  /** False when a folder could not be read or the file bound was reached. */
  complete: boolean;
}

/**
 * List every file below a workspace root once. Hidden files and folders
 * (`.obsidian`, `.trash`, `.git`) are skipped, as Obsidian does; symlinked
 * folders are not descended. An unreadable folder is skipped and marks the
 * listing incomplete, so links into it stay unresolved.
 */
export const listWorkspaceFiles = async (
  root: string,
  options: { maxFiles?: number; signal?: AbortSignal } = {}
): Promise<WorkspaceFileListing> => {
  const maxFiles = options.maxFiles ?? WORKSPACE_FILE_LISTING_MAX_FILES;
  const files: string[] = [];
  let complete = true;
  const queue: string[] = [""];
  for (let head = 0; head < queue.length; head += 1) {
    options.signal?.throwIfAborted();
    const folder = queue[head] as string;
    let entries;
    try {
      entries = await readdir(folder ? join(root, folder) : root, {
        withFileTypes: true,
      });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = (folder ? `${folder}/${entry.name}` : entry.name).normalize(
        "NFC"
      );
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.length >= maxFiles) return { files, complete: false };
        files.push(path);
      }
    }
  }
  return { files, complete };
};

/**
 * Mark unresolved plain wiki links of audited documents inside a link
 * workspace whose target exists as a workspace file. Each involved workspace
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
        link.linkType === "wiki" &&
        link.explicitCollection !== true &&
        (audited === null || audited.has(link.sourceId))
    );
  if (candidates.length === 0) return snapshot;
  const memberships = loadLinkWorkspaceMemberships(db);
  const documentRelPaths = new Map(
    snapshot.documents.map((document) => [document.id, document.relPath])
  );
  const placed = candidates.flatMap(({ link, index }) => {
    const placement = placeDocument(
      memberships.get(link.sourceCollection),
      documentRelPaths.get(link.sourceId) ?? link.sourceRelPath
    );
    return placement.key === null
      ? []
      : [{ link, index, key: placement.key, sourcePath: placement.path }];
  });
  if (placed.length === 0) return snapshot;
  const matchers = new Map<
    string,
    ReturnType<typeof createWorkspaceFileMatcher>
  >();
  const maxFiles = options.maxFiles ?? WORKSPACE_FILE_LISTING_MAX_FILES;
  let incomplete = 0;
  for (const key of new Set(placed.map((entry) => entry.key))) {
    const listing = await listWorkspaceFiles(key, {
      maxFiles,
      signal: options.signal,
    });
    if (!listing.complete) incomplete += 1;
    matchers.set(key, createWorkspaceFileMatcher(listing.files));
  }
  const links = [...snapshot.links];
  for (const entry of placed) {
    const matches = matchers.get(entry.key);
    if (matches?.(entry.link.targetRefNorm, entry.sourcePath)) {
      links[entry.index] = { ...entry.link, outsideIndex: true };
    }
  }
  return {
    ...snapshot,
    links,
    ...(incomplete > 0
      ? {
          outsideIndexDiagnostic: `The file listing of ${incomplete} link workspace${incomplete === 1 ? " was" : "s were"} incomplete (an unreadable folder, or more than ${maxFiles} files); links to files it missed stay unresolved`,
        }
      : {}),
  };
};
