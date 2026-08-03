/**
 * Filesystem stage/commit/rollback for reference-safe refactor apply.
 *
 * @module src/core/file-refactor-apply-fs
 */

// node:path dirname/relative — no Bun path utils
import { dirname, relative } from "node:path";

import type { FileRefactorJournalFileStatus } from "./file-refactor-journal";

import {
  backupFileToSibling,
  commitStagedFileExclusive,
  commitStagedFileReplace,
  removePathIfExists,
  removePathRequired,
  restoreFileFromBackup,
  siblingRefactorPath,
  writeStagedFileContent,
} from "./file-ops";
import {
  assertContainedExistingPath,
  assertContainedLiveFileAndParent,
  classifyContainedNonSymlinkFile,
  classifyPathPresence,
  ensureContainedTargetParents,
  removeOwnedEmptyDirs,
  validateRefactorJournalId,
  type RemoveOwnedEmptyDirsDeps,
} from "./file-refactor-apply-safety";
import { fingerprintUtf8Content } from "./file-refactor-contract";

export {
  cleanupReceiptArtifacts,
  resolveCollectionAbsPath,
} from "./file-refactor-apply-safety";

export type FileRefactorMutationBoundary =
  | {
      kind:
        | "stage"
        | "after_stage_write"
        | "after_stage_backup"
        | "after_target_dirs"
        | "commit"
        | "after_commit_target"
        | "rollback";
      role: "source" | "affected";
      relPath: string;
    }
  | { kind: "before_commit" }
  | { kind: "after_commit" };

export type FileRefactorBoundaryHook = (
  boundary: FileRefactorMutationBoundary
) => void | Promise<void>;

export interface PreparedRefactorFile {
  role: "source" | "affected";
  /** Live path before commit (source path for moves). */
  sourceAbsPath: string;
  /** Final absolute path after commit. */
  targetAbsPath: string;
  relPath: string;
  /** Rel path of the live source file when role is source. */
  sourceRelPath?: string;
  finalContent: string;
  originalFingerprint: string;
  expectedFingerprint: string;
  /** True when target path differs from source (rename/move). */
  isMove: boolean;
  /** Precomputed durable stage artifact absolute path. */
  stagePath: string;
  /** Precomputed durable backup artifact absolute path. */
  backupPath: string;
  /** Collection-relative stage artifact path (journal metadata). */
  stageRelPath: string;
  /** Collection-relative backup artifact path (journal metadata). */
  backupRelPath: string;
  /** Set after exclusive move target create succeeds. */
  targetCreatedByCommit?: boolean;
  /** Absolute dirs created by this transaction for the move target. */
  createdDirAbsPaths?: string[];
}

export type StagedRefactorFile = PreparedRefactorFile;

export type FileRefactorProgressCallback = (update: {
  relPath: string;
  status: FileRefactorJournalFileStatus;
}) => void | Promise<void>;

export interface FileRefactorFsHooks {
  onBoundary?: FileRefactorBoundaryHook;
  onFileProgress?: FileRefactorProgressCallback;
  /** Injectable required removal for failure injection. */
  removePathRequired?: typeof removePathRequired;
  /** Collection root used for containment re-checks at destructive boundaries. */
  collectionRoot?: string;
  /** Injectable rmdir for owned-directory cleanup failure seams. */
  rmdir?: RemoveOwnedEmptyDirsDeps["rmdir"];
}

async function invokeBoundary(
  onBoundary: FileRefactorBoundaryHook | undefined,
  boundary: FileRefactorMutationBoundary
): Promise<void> {
  if (onBoundary) await onBoundary(boundary);
}

export function assignRefactorArtifactPaths(
  files: Omit<
    PreparedRefactorFile,
    | "stagePath"
    | "backupPath"
    | "stageRelPath"
    | "backupRelPath"
    | "createdDirAbsPaths"
    | "targetCreatedByCommit"
  >[],
  collectionRoot: string,
  journalId: string
): PreparedRefactorFile[] {
  const safeJournalId = validateRefactorJournalId(journalId);
  return files.map((file, index) => {
    const token = `${safeJournalId}.${index}`;
    // Stage beside the live source path so target parents are not needed yet.
    const stagePath = siblingRefactorPath(file.sourceAbsPath, "stage", token);
    const backupPath = siblingRefactorPath(file.sourceAbsPath, "backup", token);
    return {
      ...file,
      stagePath,
      backupPath,
      stageRelPath: relative(collectionRoot, stagePath).split("\\").join("/"),
      backupRelPath: relative(collectionRoot, backupPath).split("\\").join("/"),
    };
  });
}

async function cleanupFileArtifacts(file: PreparedRefactorFile): Promise<void> {
  await removePathIfExists(file.stagePath);
  await removePathIfExists(file.backupPath);
}

export async function stageRefactorFiles(
  files: PreparedRefactorFile[],
  hooks: FileRefactorFsHooks = {},
  stagedOut: StagedRefactorFile[] = []
): Promise<StagedRefactorFile[]> {
  const collectionRoot = hooks.collectionRoot;
  if (!collectionRoot) {
    throw new Error("collectionRoot required for stage");
  }
  for (const file of files) {
    await invokeBoundary(hooks.onBoundary, {
      kind: "stage",
      role: file.role,
      relPath: file.relPath,
    });
    try {
      // Parent symlink swap after validation must fail before exclusive create.
      await assertContainedLiveFileAndParent(
        collectionRoot,
        file.sourceAbsPath
      );
      // Exclusive create — pre-existing symlink/file fails closed (EEXIST).
      await writeStagedFileContent(file.stagePath, file.finalContent);
      await invokeBoundary(hooks.onBoundary, {
        kind: "after_stage_write",
        role: file.role,
        relPath: file.relPath,
      });
      await assertContainedLiveFileAndParent(
        collectionRoot,
        file.sourceAbsPath
      );
      await backupFileToSibling(file.sourceAbsPath, file.backupPath);
      await invokeBoundary(hooks.onBoundary, {
        kind: "after_stage_backup",
        role: file.role,
        relPath: file.relPath,
      });
      stagedOut.push(file);
      if (hooks.onFileProgress) {
        await hooks.onFileProgress({
          relPath: file.relPath,
          status: "staged",
        });
      }
    } catch (cause) {
      await cleanupFileArtifacts(file);
      throw cause;
    }
  }
  return stagedOut;
}

async function liveFingerprintEquals(
  absPath: string,
  expected: string
): Promise<boolean> {
  if (!(await Bun.file(absPath).exists())) return false;
  const live = await Bun.file(absPath).text();
  return (await fingerprintUtf8Content(live)) === expected;
}

/**
 * Fingerprint only after proving the live entry is a non-symlink file whose
 * path and parent canonicalize inside collectionRoot. Symlink identity with
 * matching outside bytes must never satisfy verification.
 */
async function verifyContainedLiveFingerprint(
  collectionRoot: string,
  absPath: string,
  expectedFingerprint: string
): Promise<boolean> {
  const status = await classifyContainedNonSymlinkFile(collectionRoot, absPath);
  if (status !== "contained") return false;
  const live = await Bun.file(absPath).text();
  return (await fingerprintUtf8Content(live)) === expectedFingerprint;
}

async function verifyBackupFingerprint(
  file: StagedRefactorFile
): Promise<void> {
  if (!(await Bun.file(file.backupPath).exists())) {
    throw new Error(`Missing backup artifact for ${file.relPath}`);
  }
  const backup = await Bun.file(file.backupPath).text();
  const fingerprint = await fingerprintUtf8Content(backup);
  if (fingerprint !== file.originalFingerprint) {
    throw new Error(`Backup fingerprint mismatch for ${file.relPath}`);
  }
}

export async function commitRefactorFiles(
  staged: StagedRefactorFile[],
  hooks: FileRefactorFsHooks = {}
): Promise<void> {
  const removeRequired = hooks.removePathRequired ?? removePathRequired;
  const collectionRoot = hooks.collectionRoot;
  const affected = staged.filter((file) => file.role === "affected");
  const sources = staged.filter((file) => file.role === "source");

  if (!collectionRoot) {
    throw new Error("collectionRoot required for commit");
  }

  for (const file of [...affected, ...sources]) {
    await invokeBoundary(hooks.onBoundary, {
      kind: "commit",
      role: file.role,
      relPath: file.relPath,
    });

    const livePath = file.isMove ? file.sourceAbsPath : file.targetAbsPath;
    // Re-canonicalize live path + parent before replace/create/unlink.
    await assertContainedLiveFileAndParent(collectionRoot, livePath);
    if (!(await liveFingerprintEquals(livePath, file.originalFingerprint))) {
      throw new Error(`External mutation detected for ${file.relPath}`);
    }
    await verifyBackupFingerprint(file);

    if (file.isMove) {
      file.createdDirAbsPaths = await ensureContainedTargetParents(
        file.targetAbsPath,
        collectionRoot
      );
      await invokeBoundary(hooks.onBoundary, {
        kind: "after_target_dirs",
        role: file.role,
        relPath: file.relPath,
      });
      // Directory symlink swap after mkdir must fail closed.
      await assertContainedExistingPath(
        collectionRoot,
        dirname(file.targetAbsPath)
      );
      await commitStagedFileExclusive(file.stagePath, file.targetAbsPath);
      file.targetCreatedByCommit = true;
      await invokeBoundary(hooks.onBoundary, {
        kind: "after_commit_target",
        role: file.role,
        relPath: file.relPath,
      });
      // Swapped source parent must not route unlink outside the collection.
      await assertContainedLiveFileAndParent(
        collectionRoot,
        file.sourceAbsPath
      );
      await removeRequired(file.sourceAbsPath);
    } else {
      await commitStagedFileReplace(file.stagePath, file.targetAbsPath);
      await invokeBoundary(hooks.onBoundary, {
        kind: "after_commit_target",
        role: file.role,
        relPath: file.relPath,
      });
    }

    if (hooks.onFileProgress) {
      await hooks.onFileProgress({
        relPath: file.relPath,
        status: "committed",
      });
    }
  }

  await verifyCommittedFiles(staged, collectionRoot);
  await invokeBoundary(hooks.onBoundary, { kind: "after_commit" });
}

export async function verifyCommittedFiles(
  staged: StagedRefactorFile[],
  collectionRoot: string
): Promise<void> {
  for (const file of staged) {
    if (file.isMove) {
      if ((await classifyPathPresence(file.sourceAbsPath)) !== "missing") {
        throw new Error(`Source still present after commit: ${file.relPath}`);
      }
      if (
        !(await verifyContainedLiveFingerprint(
          collectionRoot,
          file.targetAbsPath,
          file.expectedFingerprint
        ))
      ) {
        throw new Error(`Target fingerprint mismatch: ${file.relPath}`);
      }
    } else if (
      !(await verifyContainedLiveFingerprint(
        collectionRoot,
        file.targetAbsPath,
        file.expectedFingerprint
      ))
    ) {
      throw new Error(`Affected fingerprint mismatch: ${file.relPath}`);
    }
  }
}

export async function rollbackRefactorFiles(
  staged: StagedRefactorFile[],
  commitStarted: boolean,
  hooks: FileRefactorFsHooks = {}
): Promise<{ verified: boolean }> {
  const collectionRoot = hooks.collectionRoot;
  if (!collectionRoot) return { verified: false };

  if (!commitStarted) {
    await cleanupStagingArtifacts(staged);
    const dirsOk = await cleanupOwnedDirs(staged, hooks);
    return { verified: dirsOk };
  }

  const sources = staged.filter((file) => file.role === "source");
  const affected = staged.filter((file) => file.role === "affected");

  for (const file of [...sources, ...affected]) {
    try {
      await invokeBoundary(hooks.onBoundary, {
        kind: "rollback",
        role: file.role,
        relPath: file.relPath,
      });
      if (file.isMove) {
        if (file.targetCreatedByCommit) {
          const targetIsOurs = await verifyContainedLiveFingerprint(
            collectionRoot,
            file.targetAbsPath,
            file.expectedFingerprint
          );
          if (targetIsOurs) await removePathIfExists(file.targetAbsPath);
        }
        if (await Bun.file(file.backupPath).exists()) {
          const missing = !(await Bun.file(file.sourceAbsPath).exists());
          const isOriginal = !missing
            ? await liveFingerprintEquals(
                file.sourceAbsPath,
                file.originalFingerprint
              )
            : false;
          // Replace missing paths or non-original entries (incl. swapped symlinks).
          if (missing || !isOriginal) {
            await assertContainedExistingPath(
              collectionRoot,
              dirname(file.sourceAbsPath)
            );
            await restoreFileFromBackup(file.backupPath, file.sourceAbsPath);
          }
        }
      } else if (await Bun.file(file.backupPath).exists()) {
        const missing = !(await Bun.file(file.targetAbsPath).exists());
        const isOriginal = !missing
          ? await liveFingerprintEquals(
              file.targetAbsPath,
              file.originalFingerprint
            )
          : false;
        const isOurs = !missing
          ? await liveFingerprintEquals(
              file.targetAbsPath,
              file.expectedFingerprint
            )
          : false;
        if (missing || isOurs) {
          await assertContainedExistingPath(
            collectionRoot,
            dirname(file.targetAbsPath)
          );
          await restoreFileFromBackup(file.backupPath, file.targetAbsPath);
        } else if (!isOriginal) {
          // External mutation — leave bytes untouched.
        }
      }
      if (hooks.onFileProgress) {
        await hooks.onFileProgress({
          relPath: file.relPath,
          status: "restored",
        });
      }
    } catch {
      if (hooks.onFileProgress) {
        await hooks.onFileProgress({
          relPath: file.relPath,
          status: "failed",
        });
      }
    }
  }

  const verified = await verifyRollback(staged, collectionRoot);
  if (!verified) return { verified: false };
  await cleanupStagingArtifacts(staged);
  // Owned dirs must be gone; leftover dirs ⇒ recovery_required, not rolled_back.
  const dirsOk = await cleanupOwnedDirs(staged, hooks);
  return { verified: dirsOk };
}

async function verifyRollback(
  staged: StagedRefactorFile[],
  collectionRoot: string
): Promise<boolean> {
  if (!collectionRoot) return false;
  for (const file of staged) {
    if (file.isMove) {
      if ((await classifyPathPresence(file.targetAbsPath)) !== "missing") {
        return false;
      }
      if (
        !(await verifyContainedLiveFingerprint(
          collectionRoot,
          file.sourceAbsPath,
          file.originalFingerprint
        ))
      ) {
        return false;
      }
    } else if (
      !(await verifyContainedLiveFingerprint(
        collectionRoot,
        file.targetAbsPath,
        file.originalFingerprint
      ))
    ) {
      return false;
    }
  }
  return true;
}

async function cleanupOwnedDirs(
  staged: StagedRefactorFile[],
  hooks: FileRefactorFsHooks = {}
): Promise<boolean> {
  const collectionRoot = hooks.collectionRoot;
  if (!collectionRoot) return false;
  let ok = true;
  for (const file of staged) {
    if (!file.createdDirAbsPaths?.length) continue;
    const result = await removeOwnedEmptyDirs(
      file.createdDirAbsPaths,
      collectionRoot,
      {
        rmdir: hooks.rmdir,
      }
    );
    file.createdDirAbsPaths = result.failed;
    if (!result.ok) ok = false;
  }
  return ok;
}

export async function cleanupStagingArtifacts(
  staged: StagedRefactorFile[]
): Promise<void> {
  for (const file of staged) {
    await cleanupFileArtifacts(file);
  }
}

export async function cleanupAfterSuccessfulCommit(
  staged: StagedRefactorFile[]
): Promise<void> {
  await cleanupStagingArtifacts(staged);
  // Successful commit keeps target dirs; clear ownership tracking only.
  for (const file of staged) {
    file.createdDirAbsPaths = [];
  }
}
