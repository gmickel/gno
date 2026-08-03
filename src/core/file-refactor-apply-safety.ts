/**
 * Artifact path, journal-id, and owned-directory safety for refactor apply.
 *
 * @module src/core/file-refactor-apply-safety
 */

// node:fs/promises — mkdir/realpath/lstat/rmdir; no Bun equivalents for structure ops
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
// node:path — no Bun path utils
import { dirname, join, normalize } from "node:path";

import { removePathRequired } from "./file-ops";
import { isCanonicalPathContained, validateRelPath } from "./validation";

const JOURNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const STAGE_ARTIFACT_BASE_RE =
  /^.+\.gno-rf-stage\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BACKUP_ARTIFACT_BASE_RE =
  /^.+\.gno-rf-backup\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isEexist(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/** Bounded token used in sibling artifact filenames (default UUID passes). */
export function validateRefactorJournalId(journalId: string): string {
  if (!JOURNAL_ID_RE.test(journalId)) {
    throw new Error("Invalid refactor journal id");
  }
  return journalId;
}

export function isRefactorFingerprint(value: string): boolean {
  return FINGERPRINT_RE.test(value);
}

/**
 * Canonical collection-relative artifact path with the expected marker.
 * Rejects absolute/traversal/corrupt paths without touching the filesystem.
 */
export function validateRefactorArtifactRelPath(
  relPath: string,
  kind: "stage" | "backup"
): string {
  const canonical = validateRelPath(relPath);
  const base = canonical.split("/").pop() ?? "";
  const ok =
    kind === "stage"
      ? STAGE_ARTIFACT_BASE_RE.test(base)
      : BACKUP_ARTIFACT_BASE_RE.test(base);
  if (!ok) {
    throw new Error(`Invalid refactor ${kind} artifact relPath`);
  }
  return canonical;
}

export function tryValidateRefactorArtifactRelPath(
  relPath: string,
  kind: "stage" | "backup"
): string | null {
  try {
    return validateRefactorArtifactRelPath(relPath, kind);
  } catch {
    return null;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Re-check that an absolute path stays inside the collection after realpath.
 * Used after creating target directories and before exclusive target create.
 */
export async function assertContainedExistingPath(
  collectionRootAbs: string,
  absPath: string
): Promise<void> {
  const rootReal = await realpathOrNull(normalize(collectionRootAbs));
  if (!rootReal) {
    throw new Error("Collection root is not resolvable");
  }
  const real = await realpathOrNull(absPath);
  if (!real || !isCanonicalPathContained(rootReal, real)) {
    throw new Error("Path escapes collection root");
  }
}

/**
 * TOCTOU recheck: live file and its parent must both realpath inside the root.
 * Parent-directory symlink swaps after initial validation fail closed here.
 */
export async function assertContainedLiveFileAndParent(
  collectionRootAbs: string,
  fileAbsPath: string
): Promise<void> {
  await assertContainedExistingPath(collectionRootAbs, fileAbsPath);
  await assertContainedExistingPath(collectionRootAbs, dirname(fileAbsPath));
}

/**
 * Classify a final live file for post-commit/rollback verification.
 * Symlink identity is never accepted: the directory entry must be a real file
 * whose path and parent both canonicalize inside the collection root.
 */
export async function classifyContainedNonSymlinkFile(
  collectionRootAbs: string,
  fileAbsPath: string
): Promise<"missing" | "contained" | "unsafe"> {
  const rootReal = await realpathOrNull(normalize(collectionRootAbs));
  if (!rootReal) return "unsafe";
  try {
    const info = await lstat(fileAbsPath);
    if (info.isSymbolicLink() || !info.isFile()) return "unsafe";
    const real = await realpath(fileAbsPath);
    if (!isCanonicalPathContained(rootReal, real)) return "unsafe";
    const parentReal = await realpath(dirname(fileAbsPath));
    if (!isCanonicalPathContained(rootReal, parentReal)) return "unsafe";
    return "contained";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    return "unsafe";
  }
}

/**
 * Directory-entry presence without following symlinks.
 * Any existing entry (file/dir/symlink) is present; unprovable errors are unsafe.
 */
export async function classifyPathPresence(
  absPath: string
): Promise<"missing" | "present" | "unsafe"> {
  try {
    await lstat(absPath);
    return "present";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    return "unsafe";
  }
}

/**
 * Classify whether an existing path is missing, contained, or unprovable/unsafe.
 * Used by receipt cleanup before unlink (parent symlink escape defense).
 */
export async function classifyContainedExistingPath(
  collectionRootAbs: string,
  absPath: string
): Promise<"missing" | "contained" | "unsafe"> {
  const rootReal = await realpathOrNull(normalize(collectionRootAbs));
  if (!rootReal) return "unsafe";
  try {
    const real = await realpath(absPath);
    return isCanonicalPathContained(rootReal, real) ? "contained" : "unsafe";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    return "unsafe";
  }
}

/**
 * Create missing parents of targetAbsPath. Returns only directories this call
 * created (shallow→deep). Pre-existing directories are never owned/removed.
 */
export async function ensureContainedTargetParents(
  targetAbsPath: string,
  collectionRootAbs: string
): Promise<string[]> {
  const rootReal = await realpathOrNull(normalize(collectionRootAbs));
  if (!rootReal) {
    throw new Error("Collection root is not resolvable");
  }

  const targetParent = dirname(targetAbsPath);
  const missing: string[] = [];
  let cursor = targetParent;
  while (true) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  const existingReal = await realpathOrNull(cursor);
  if (!existingReal || !isCanonicalPathContained(rootReal, existingReal)) {
    throw new Error("Target parent escapes collection root");
  }

  const created: string[] = [];
  for (const dir of missing.reverse()) {
    try {
      // Single-level create so ownership is exact (no recursive surprise).
      await mkdir(dir, { recursive: false });
      created.push(dir);
    } catch (error) {
      if (!isEexist(error)) {
        await removeOwnedEmptyDirs(created, collectionRootAbs);
        throw error;
      }
      // Race: directory appeared — not owned by this transaction.
    }
    const dirReal = await realpathOrNull(dir);
    if (!dirReal || !isCanonicalPathContained(rootReal, dirReal)) {
      await removeOwnedEmptyDirs(created, collectionRootAbs);
      throw new Error("Target parent escaped collection after create");
    }
  }

  await assertContainedExistingPath(collectionRootAbs, targetParent);
  return created;
}

export type RemoveOwnedEmptyDirsResult = {
  ok: boolean;
  /** Dirs that remain after a non-ENOENT removal failure. */
  failed: string[];
};

export type RemoveOwnedEmptyDirsDeps = {
  /** Injectable rmdir for permission/failure seams in tests. */
  rmdir?: typeof rmdir;
};

/**
 * Remove owned dirs deepest-first, and only when empty. Never force-remove.
 * Before each rmdir, the directory and its parent must canonicalize inside
 * collectionRoot and the entry must be a real directory (not a symlink).
 * Unprovable/outside/symlink paths are left untouched and reported failed so
 * callers cannot claim rolled_back after escaping through a swapped parent.
 * ENOENT is success (already gone / external race).
 */
export async function removeOwnedEmptyDirs(
  createdDirAbsPaths: string[],
  collectionRootAbs: string,
  deps: RemoveOwnedEmptyDirsDeps = {}
): Promise<RemoveOwnedEmptyDirsResult> {
  const remove = deps.rmdir ?? rmdir;
  const failed: string[] = [];
  const rootReal = await realpathOrNull(normalize(collectionRootAbs));
  if (!rootReal) {
    return { ok: false, failed: [...createdDirAbsPaths] };
  }
  for (const dir of [...createdDirAbsPaths].reverse()) {
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        failed.push(dir);
        continue;
      }
      const dirReal = await realpath(dir);
      const parentReal = await realpath(dirname(dir));
      if (
        !isCanonicalPathContained(rootReal, dirReal) ||
        !isCanonicalPathContained(rootReal, parentReal)
      ) {
        failed.push(dir);
        continue;
      }
      await remove(dir);
    } catch (error) {
      if (isEnoent(error)) continue;
      failed.push(dir);
    }
  }
  return { ok: failed.length === 0, failed };
}

export function resolveCollectionAbsPath(
  collectionRoot: string,
  relPath: string
): string {
  return join(collectionRoot, ...relPath.split("/"));
}

/**
 * Required receipt-artifact cleanup. Invalid/traversal paths fail closed
 * without touching outside. Before unlink, the artifact parent must realpath
 * inside the collection (parent symlink escape). Missing parent/path is safe
 * ENOENT. Unprovable/outside parents return false without unlinking.
 */
export async function cleanupReceiptArtifacts(
  collectionRoot: string,
  stageRelPaths: Array<string | undefined>,
  backupRelPaths: Array<string | undefined>,
  removeFn: typeof removePathRequired = removePathRequired
): Promise<boolean> {
  try {
    const removeOne = async (
      rel: string,
      kind: "stage" | "backup"
    ): Promise<boolean> => {
      const safe = tryValidateRefactorArtifactRelPath(rel, kind);
      if (!safe) return false;
      const abs = resolveCollectionAbsPath(collectionRoot, safe);
      const parentStatus = await classifyContainedExistingPath(
        collectionRoot,
        dirname(abs)
      );
      if (parentStatus === "missing") return true;
      if (parentStatus === "unsafe") return false;
      await removeFn(abs);
      return true;
    };
    for (const rel of stageRelPaths) {
      if (!rel) continue;
      if (!(await removeOne(rel, "stage"))) return false;
    }
    for (const rel of backupRelPaths) {
      if (!rel) continue;
      if (!(await removeOne(rel, "backup"))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
