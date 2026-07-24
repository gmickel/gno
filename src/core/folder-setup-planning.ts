/**
 * Safe folder preflight and deterministic collection selection.
 *
 * @module src/core/folder-setup-planning
 */

// node:fs constants have no Bun equivalent.
import { constants as fsConstants } from "node:fs";
// node:fs/promises provides directory access, realpath, and stat APIs without Bun equivalents.
import { access, realpath, stat } from "node:fs/promises";
// node:path has no Bun equivalent.
import { basename, dirname, extname, resolve } from "node:path";

import type { Collection, Config } from "../config";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { canonicalizeIndexName } from "../app/index-name";
import { addCollection } from "../collection/add";
import { CollectionSchema, DEFAULT_PATTERN } from "../config";
import { isSupportedExtension } from "../converters/mime";
import { DEFAULT_LIMITS } from "../converters/types";
import { defaultWalker } from "../ingestion";
import { isCanonicalPathContained, validateCollectionRoot } from "./validation";

const INVALID_NAME_CHARS = /[^a-z0-9_-]/g;
const LEADING_NON_ALPHANUMERIC = /^[^a-z0-9]+/;
import { hasLikelySecretPath, matchesCollectionExclusion } from "./path-rules";

export type FolderSetupErrorCode =
  | "folder_not_found"
  | "folder_not_directory"
  | "folder_unreadable"
  | "dangerous_root"
  | "secret_risk"
  | "empty_folder"
  | "unsupported_only"
  | "no_indexable_lexical_corpus"
  | "config_load_failed"
  | "invalid_collection_name"
  | "collection_name_conflict"
  | "collection_overlap"
  | "collection_filter_disagreement"
  | "store_status_failed"
  | "store_index_mismatch"
  | "setup_path_overlap"
  | "config_save_failed"
  | "store_sync_failed"
  | "lexical_index_failed"
  | "lexical_proof_failed"
  | "injected_failure"
  | "receipt_write_failed";

export interface FolderSetupError {
  code: FolderSetupErrorCode;
  message: string;
  remediation: string;
}

export interface CollectionSelection {
  collection: Collection;
  disposition: "created" | "reused";
  config: Config;
}

export function setupError(
  code: FolderSetupErrorCode,
  message: string,
  remediation: string
): FolderSetupError {
  return { code, message, remediation };
}

export function normalizeSetupExcludes(excludes: readonly string[]): string[] {
  return [...new Set(excludes)].sort();
}

export function setupExcludesMatch(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const normalizedLeft = normalizeSetupExcludes(left);
  const normalizedRight = normalizeSetupExcludes(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export function setupFilterDisagreement(
  collection: Collection
): FolderSetupError {
  return setupError(
    "collection_filter_disagreement",
    `Requested exclusions do not match reused collection "${collection.name}"`,
    "Omit setup exclusions to reuse the configured filters, or make the collection filters match before retrying."
  );
}

export function setupInjectedFailure(checkpoint: string): FolderSetupError {
  return setupError(
    "injected_failure",
    `Injected setup interruption at ${checkpoint}`,
    "Rerun setup for the same folder to resume."
  );
}

async function listFolderFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*");
  for await (const relPath of glob.scan({
    cwd: folder,
    onlyFiles: true,
    followSymlinks: false,
    dot: true,
  })) {
    files.push(relPath.replaceAll("\\", "/"));
  }
  return files.sort();
}

function deriveCollectionName(folder: string): string | null {
  const name = basename(folder)
    .toLowerCase()
    .replace(INVALID_NAME_CHARS, "-")
    .replace(LEADING_NON_ALPHANUMERIC, "");
  return name.length > 0 ? name.slice(0, 64) : null;
}

function nextDerivedName(base: string, config: Config): string {
  const names = new Set(config.collections.map((item) => item.name));
  if (!names.has(base)) {
    return base;
  }
  for (
    let suffixNumber = 2;
    suffixNumber < Number.MAX_SAFE_INTEGER;
    suffixNumber += 1
  ) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to derive a unique collection name");
}

async function canonicalCollectionPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function canonicalOperationalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const unresolvedSegments: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      const existingAncestor = await realpath(candidate);
      return resolve(existingAncestor, ...unresolvedSegments.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        return absolute;
      }
      unresolvedSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function validateSetupOutputPaths(
  folder: string,
  paths: ReadonlyArray<{ label: string; path: string }>
): Promise<FolderSetupError | null> {
  const canonicalFolder = await canonicalOperationalPath(folder);
  for (const output of paths) {
    const canonicalPath = await canonicalOperationalPath(output.path);
    if (isCanonicalPathContained(canonicalFolder, canonicalPath)) {
      return setupError(
        "setup_path_overlap",
        `${output.label} path is inside the source folder: ${canonicalPath}`,
        "Choose config, data, and index paths outside the folder being indexed."
      );
    }
  }
  return null;
}

export async function resolveSetupStoreIndex(input: {
  store: SqliteAdapter;
  requestedIndexName?: string;
}): Promise<{ indexName: string; dbPath: string } | FolderSetupError> {
  const status = await input.store.getStatus();
  if (!status.ok) {
    return setupError(
      "store_status_failed",
      `Cannot inspect the selected index: ${status.error.message}`,
      "Open a healthy local index store and retry."
    );
  }
  let storeIndexName: string;
  try {
    storeIndexName = canonicalizeIndexName(status.value.indexName);
  } catch {
    return setupError(
      "store_index_mismatch",
      `Opened store has an invalid index identity: ${status.value.indexName}`,
      "Open the intended canonical index store and retry."
    );
  }
  if (input.requestedIndexName === undefined) {
    return { indexName: storeIndexName, dbPath: status.value.dbPath };
  }
  let requestedIndexName: string;
  try {
    requestedIndexName = canonicalizeIndexName(input.requestedIndexName);
  } catch {
    return setupError(
      "store_index_mismatch",
      `Requested index identity is invalid: ${input.requestedIndexName}`,
      "Choose the canonical identity of the opened index store."
    );
  }
  if (requestedIndexName !== storeIndexName) {
    return setupError(
      "store_index_mismatch",
      `Opened store is "${storeIndexName}", not "${requestedIndexName}"`,
      "Pass the opened store's canonical index name or open the intended store."
    );
  }
  return { indexName: storeIndexName, dbPath: status.value.dbPath };
}

export async function selectFolderCollection(
  config: Config,
  folder: string,
  requestedName: string | undefined,
  excludes: string[]
): Promise<CollectionSelection | FolderSetupError> {
  const configured = await Promise.all(
    config.collections.map(async (collection) => ({
      collection,
      path: await canonicalCollectionPath(collection.path),
    }))
  );
  const exact = configured.find((item) => item.path === folder);
  const explicitName = requestedName?.trim().toLowerCase();
  if (exact) {
    if (explicitName && explicitName !== exact.collection.name) {
      return setupError(
        "collection_name_conflict",
        `Folder is already configured as "${exact.collection.name}", not "${explicitName}"`,
        `Reuse "${exact.collection.name}" or omit the explicit name.`
      );
    }
    return {
      collection: exact.collection,
      disposition: "reused",
      config,
    };
  }

  const overlap = configured.find(
    (item) =>
      isCanonicalPathContained(item.path, folder) ||
      isCanonicalPathContained(folder, item.path)
  );
  if (overlap) {
    return setupError(
      "collection_overlap",
      `Folder overlaps configured collection "${overlap.collection.name}"`,
      "Choose a non-overlapping folder or remove the existing collection first."
    );
  }

  const derivedName = deriveCollectionName(folder);
  const name = explicitName
    ? explicitName
    : derivedName
      ? nextDerivedName(derivedName, config)
      : null;
  if (!name || !CollectionSchema.shape.name.safeParse(name).success) {
    return setupError(
      "invalid_collection_name",
      `Cannot use collection name derived from "${basename(folder)}"`,
      "Provide a lowercase alphanumeric collection name up to 64 characters."
    );
  }
  if (explicitName && config.collections.some((item) => item.name === name)) {
    return setupError(
      "collection_name_conflict",
      `Collection "${name}" already points to another folder`,
      "Choose a different explicit collection name."
    );
  }

  const added = await addCollection(config, {
    path: folder,
    name,
    pattern: DEFAULT_PATTERN,
    exclude: excludes,
  });
  return added.ok
    ? {
        collection: added.collection,
        disposition: "created",
        config: added.config,
      }
    : setupError(
        added.code === "DUPLICATE" || added.code === "DUPLICATE_PATH"
          ? "collection_name_conflict"
          : "invalid_collection_name",
        added.message,
        "Review the folder and collection name, then retry."
      );
}

export async function preflightFolder(
  folder: string,
  excludes: string[],
  secretRiskAuthorized: boolean
): Promise<FolderSetupError | null> {
  let files: string[];
  try {
    files = (await listFolderFiles(folder)).filter(
      (path) => !matchesCollectionExclusion(path, excludes)
    );
  } catch {
    return setupError(
      "folder_unreadable",
      `Folder is not readable: ${folder}`,
      "Grant read and traversal access, then retry."
    );
  }
  if (files.length === 0) {
    return setupError(
      "empty_folder",
      `Folder contains no non-excluded files: ${folder}`,
      "Add supported documents or choose another folder."
    );
  }
  if (
    !secretRiskAuthorized &&
    files.some((path) => hasLikelySecretPath(path))
  ) {
    return setupError(
      "secret_risk",
      `Folder contains likely credential or secret files: ${folder}`,
      "Add explicit exclusions or authorize the risk in the calling surface."
    );
  }
  if (!files.some((path) => isSupportedExtension(extname(path)))) {
    return setupError(
      "unsupported_only",
      `Folder contains no supported document types: ${folder}`,
      "Add a supported document or choose another folder."
    );
  }

  const walked = await defaultWalker.walk({
    root: folder,
    pattern: DEFAULT_PATTERN,
    include: [],
    exclude: excludes,
    maxBytes: DEFAULT_LIMITS.maxBytes,
  });
  if (walked.entries.length === 0) {
    return setupError(
      "no_indexable_lexical_corpus",
      `Folder has no supported documents within lexical indexing limits: ${folder}`,
      "Reduce file sizes, adjust exclusions, or add an indexable document."
    );
  }
  return null;
}

export async function resolveSetupFolder(
  input: string
): Promise<{ folder: string } | { error: FolderSetupError }> {
  const absolute = resolve(input);
  let folder: string;
  try {
    folder = await realpath(absolute);
  } catch (error) {
    const unreadable =
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM");
    return {
      error: setupError(
        unreadable ? "folder_unreadable" : "folder_not_found",
        unreadable
          ? `Folder is not readable: ${absolute}`
          : `Folder does not exist: ${absolute}`,
        unreadable
          ? "Grant read and traversal access, then retry."
          : "Choose an existing local folder."
      ),
    };
  }
  const metadata = await stat(folder);
  if (!metadata.isDirectory()) {
    return {
      error: setupError(
        "folder_not_directory",
        `Path is not a directory: ${folder}`,
        "Choose a directory."
      ),
    };
  }
  try {
    await access(folder, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return {
      error: setupError(
        "folder_unreadable",
        `Folder is not readable: ${folder}`,
        "Grant read and traversal access, then retry."
      ),
    };
  }
  try {
    await validateCollectionRoot(folder);
  } catch {
    return {
      error: setupError(
        "dangerous_root",
        `Folder resolves to a dangerous broad root: ${folder}`,
        "Choose a narrower content folder."
      ),
    };
  }
  return { folder };
}
