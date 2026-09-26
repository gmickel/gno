/**
 * Link workspaces: collections whose roots share one workspace root resolve
 * plain wiki links across each other (Obsidian vault semantics).
 *
 * Membership is derived from the filesystem, never stored in content: the
 * nearest ancestor-or-self directory containing `.obsidian/`, or an explicit
 * per-collection `workspaceRoot` (absolute path, or `false` to opt out).
 * Ownership is finally decided per document: a nested vault (`.obsidian/`
 * below the collection root) forms its own workspace.
 *
 * @module src/core/link-workspace
 */

// node:fs has no Bun equivalent for synchronous realpath/stat of directories.
import { realpathSync, statSync } from "node:fs";
// node:path provides platform-correct path algebra; Bun has no path utilities.
import { dirname, isAbsolute, relative, sep } from "node:path";

/** Bump when resolution semantics change; enters projection fingerprints. */
export const LINK_RESOLVER_VERSION = 2;

export const WORKSPACE_MARKER_DIR = ".obsidian";

export type LinkWorkspaceSource =
  /** No workspace root: collection-scoped resolution (today's behaviour). */
  | "none"
  /** Nearest `.obsidian/` ancestor-or-self of the collection root. */
  | "detected"
  /** Explicit absolute `workspaceRoot`. */
  | "configured"
  /** Explicit `workspaceRoot: false` opt-out. */
  | "disabled"
  /** Root or ancestors could not be inspected; fails closed to collection scope. */
  | "unavailable";

export interface CollectionWorkspaceInfo {
  /** Canonical (real) collection root, or null when it cannot be resolved. */
  realPath: string | null;
  /** Canonical workspace root, or null for collection-scoped resolution. */
  root: string | null;
  source: LinkWorkspaceSource;
}

/** Stored membership of one collection, as read back from the index. */
export interface CollectionWorkspaceMembership extends CollectionWorkspaceInfo {
  collection: string;
  /** Collection-relative POSIX prefixes that hold their own `.obsidian/`. */
  nested: string[];
}

type DirProbe = "present" | "absent" | "error";

const probeMarker = (directory: string): DirProbe => {
  try {
    return statSync(`${directory}${sep}${WORKSPACE_MARKER_DIR}`).isDirectory()
      ? "present"
      : "absent";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
};

const canonical = (path: string): string | null => {
  try {
    return realpathSync(path).normalize("NFC");
  } catch {
    return null;
  }
};

/** Join a POSIX relative path onto a native absolute root. */
const nativeJoin = (root: string, posixPath: string): string =>
  `${root}${sep}${posixPath.split("/").join(sep)}`;

/** True when `child` equals `parent` or sits inside it (component-wise). */
export const pathContains = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** POSIX path of `child` relative to `parent` ('' when equal). */
export const posixRelative = (parent: string, child: string): string =>
  relative(parent, child).split(sep).join("/").normalize("NFC");

export type WorkspaceRootSettingError =
  | "not_absolute"
  | "not_found"
  | "not_containing";

/** Validate an explicit `workspaceRoot` against the collection root. */
export const validateWorkspaceRootSetting = (
  collectionPath: string,
  workspaceRoot: string
): WorkspaceRootSettingError | null => {
  if (!isAbsolute(workspaceRoot)) return "not_absolute";
  const root = canonical(workspaceRoot);
  if (root === null) return "not_found";
  try {
    if (!statSync(root).isDirectory()) return "not_found";
  } catch {
    return "not_found";
  }
  const collectionRoot = canonical(collectionPath) ?? collectionPath;
  return pathContains(root, collectionRoot) ? null : "not_containing";
};

export const workspaceRootSettingMessage = (
  collection: string,
  error: WorkspaceRootSettingError
): string => {
  switch (error) {
    case "not_absolute":
      return `Collection "${collection}": workspaceRoot must be an absolute path`;
    case "not_found":
      return `Collection "${collection}": workspaceRoot does not exist or is not a directory`;
    case "not_containing":
      return `Collection "${collection}": workspaceRoot must contain the collection root`;
  }
};

/**
 * Resolve one collection's workspace from its root. Real paths are used
 * throughout; an unreadable root or ancestor never joins a broader workspace.
 */
export const detectCollectionWorkspace = (collection: {
  path: string;
  workspaceRoot?: string | false;
}): CollectionWorkspaceInfo => {
  const realPath = canonical(collection.path);
  if (collection.workspaceRoot === false) {
    return { realPath, root: null, source: "disabled" };
  }
  if (realPath === null) {
    return { realPath: null, root: null, source: "unavailable" };
  }
  if (typeof collection.workspaceRoot === "string") {
    const invalid = validateWorkspaceRootSetting(
      collection.path,
      collection.workspaceRoot
    );
    const root = invalid ? null : canonical(collection.workspaceRoot);
    return root === null
      ? { realPath, root: null, source: "unavailable" }
      : { realPath, root, source: "configured" };
  }
  let current = realPath;
  for (;;) {
    const probe = probeMarker(current);
    if (probe === "present") {
      return { realPath, root: current, source: "detected" };
    }
    if (probe === "error") {
      return { realPath, root: null, source: "unavailable" };
    }
    const parent = dirname(current);
    if (parent === current) {
      return { realPath, root: null, source: "none" };
    }
    current = parent;
  }
};

/**
 * Find nested vaults inside a collection: every ancestor directory of an
 * indexed document (below the collection root) that holds `.obsidian/`.
 * Bounded by distinct directories, never by link count.
 */
export const detectNestedWorkspacePrefixes = (
  realRoot: string,
  relPaths: Iterable<string>
): string[] => {
  const directories = new Set<string>();
  for (const relPath of relPaths) {
    let directory = relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/"))
      : "";
    while (directory && !directories.has(directory)) {
      directories.add(directory);
      directory = directory.includes("/")
        ? directory.slice(0, directory.lastIndexOf("/"))
        : "";
    }
  }
  const nested: string[] = [];
  for (const directory of directories) {
    if (probeMarker(nativeJoin(realRoot, directory)) === "present") {
      nested.push(directory.normalize("NFC"));
    }
  }
  return nested.sort();
};

/**
 * Fingerprint input for effective link resolution: resolver version plus the
 * membership of every collection that belongs to (or contains) a workspace.
 * Undefined when no collection is in a workspace, so collection-scoped
 * indexes keep their existing fingerprints.
 */
export const linkResolutionFingerprintInput = (
  rows: ReadonlyArray<{
    name: string;
    realPath?: string | null;
    workspaceRoot?: string | null;
    workspaceSource?: LinkWorkspaceSource;
    workspaceNested?: string[];
  }>
):
  | {
      version: number;
      workspaces: Array<{
        collection: string;
        realPath: string | null;
        root: string | null;
        source: LinkWorkspaceSource;
        nested: string[];
      }>;
    }
  | undefined => {
  const workspaces = rows
    .filter(
      (row) =>
        (row.workspaceRoot ?? null) !== null ||
        (row.workspaceNested?.length ?? 0) > 0
    )
    .map((row) => ({
      collection: row.name,
      realPath: row.realPath ?? null,
      root: row.workspaceRoot ?? null,
      source: row.workspaceSource ?? "none",
      nested: [...(row.workspaceNested ?? [])].sort(),
    }))
    .sort((left, right) =>
      left.collection < right.collection
        ? -1
        : left.collection > right.collection
          ? 1
          : 0
    );
  return workspaces.length > 0
    ? { version: LINK_RESOLVER_VERSION, workspaces }
    : undefined;
};

/**
 * One-line link workspace description for status output, or null for a
 * collection that is not in a workspace. A redacted root prints no path.
 */
export const formatLinkWorkspace = (collection: {
  workspaceRoot?: string | null;
  workspaceSource?: string;
}): string | null => {
  switch (collection.workspaceSource) {
    case "detected":
    case "configured":
      return collection.workspaceRoot
        ? `${collection.workspaceRoot} (${collection.workspaceSource})`
        : collection.workspaceSource;
    case "disabled":
      return "off (links stay inside this collection)";
    case "unavailable":
      return "unavailable (links stay inside this collection)";
    default:
      return null;
  }
};

/** Workspace identity and workspace-relative path of one document. */
export interface DocumentWorkspacePlacement {
  /** Canonical workspace root (the workspace identity), or null. */
  key: string | null;
  /** Document path relative to the workspace root (POSIX, NFC). */
  path: string;
}

/** Collection root relative to its workspace root, per membership object. */
const workspacePrefixes = new WeakMap<CollectionWorkspaceMembership, string>();

/**
 * Place a document into its workspace: the deepest nested vault containing
 * it, else its collection's workspace. Collection-scoped collections (none,
 * disabled, unavailable) never place documents into a workspace, except that
 * nested vaults still own their documents when the collection root is known
 * and not opted out.
 */
export const placeDocument = (
  membership: CollectionWorkspaceMembership | undefined,
  relPath: string
): DocumentWorkspacePlacement => {
  const normalized = relPath.normalize("NFC");
  if (
    !membership ||
    membership.realPath === null ||
    membership.source === "disabled" ||
    membership.source === "unavailable"
  ) {
    return { key: null, path: normalized };
  }
  let nestedPrefix: string | null = null;
  for (const prefix of membership.nested) {
    if (
      normalized.startsWith(`${prefix}/`) &&
      (nestedPrefix === null || prefix.length > nestedPrefix.length)
    ) {
      nestedPrefix = prefix;
    }
  }
  if (nestedPrefix !== null) {
    return {
      key: nativeJoin(membership.realPath, nestedPrefix),
      path: normalized.slice(nestedPrefix.length + 1),
    };
  }
  if (membership.root === null) return { key: null, path: normalized };
  let prefix = workspacePrefixes.get(membership);
  if (prefix === undefined) {
    prefix = posixRelative(membership.root, membership.realPath);
    workspacePrefixes.set(membership, prefix);
  }
  return {
    key: membership.root,
    path: prefix ? `${prefix}/${normalized}` : normalized,
  };
};
