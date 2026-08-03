/**
 * Transport-neutral collection-scoped apply service for reference-safe refactors.
 *
 * Validates an exact preview plan, stages/commits or restores the full file set,
 * records a content-free recovery receipt, then drives index convergence.
 *
 * @module src/core/file-refactor-service
 */

import type { WriteLockHandle } from "./file-lock";
import type {
  FileRefactorApplyRequest,
  FileRefactorApplyResult,
  FileRefactorPreviewPlan,
  FileRefactorReasonCode,
} from "./file-refactor-contract";
import type {
  FileRefactorJournalFileEntry,
  FileRefactorJournalPort,
  FileRefactorRecoveryReceipt,
} from "./file-refactor-journal";

import { acquireWriteLock } from "./file-lock";
import { removePathRequired } from "./file-ops";
import {
  assignRefactorArtifactPaths,
  cleanupAfterSuccessfulCommit,
  cleanupReceiptArtifacts,
  commitRefactorFiles,
  rollbackRefactorFiles,
  stageRefactorFiles,
  type FileRefactorBoundaryHook,
  type PreparedRefactorFile,
  type StagedRefactorFile,
} from "./file-refactor-apply-fs";
import {
  validateRefactorJournalId,
  type RemoveOwnedEmptyDirsDeps,
} from "./file-refactor-apply-safety";
import {
  baseResult,
  unchangedResult,
  validateLiveRefactorPlan,
  validateRefactorPlanStructure,
} from "./file-refactor-apply-validate";
import {
  computeFileRefactorPlanDigest,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "./file-refactor-contract";
import {
  FILE_REFACTOR_SYNC_PENDING_INSTRUCTION,
  isCommittedFilesystemPhase,
  isUncertainJournalPhase,
} from "./file-refactor-journal";

export type { FileRefactorBoundaryHook } from "./file-refactor-apply-fs";
export {
  createMemoryFileRefactorJournal,
  journalPortFromStore,
} from "./file-refactor-journal-port";

export type FileRefactorSyncCallback = (input: {
  plan: FileRefactorPreviewPlan;
  receipt: FileRefactorRecoveryReceipt;
  signal?: AbortSignal;
}) => Promise<void>;

export interface ApplyFileRefactorDeps {
  collectionRoot: string;
  lockPath: string;
  journal: FileRefactorJournalPort;
  syncAfterCommit: FileRefactorSyncCallback;
  acquireLock?: typeof acquireWriteLock;
  lockTimeoutMs?: number;
  onBoundary?: FileRefactorBoundaryHook;
  nowMs?: () => number;
  createJournalId?: () => string;
  /** Injectable required removal for race/failure injection tests. */
  removePathRequired?: typeof removePathRequired;
  /** Injectable rmdir for owned-directory cleanup failure seams. */
  rmdir?: RemoveOwnedEmptyDirsDeps["rmdir"];
}

function receiptFileEntries(
  files: PreparedRefactorFile[]
): FileRefactorJournalFileEntry[] {
  return files.map((file) => ({
    role: file.role === "source" ? "source" : "affected",
    relPath:
      file.role === "source"
        ? (file.sourceRelPath ?? file.relPath)
        : file.relPath,
    stageRelPath: file.stageRelPath,
    backupRelPath: file.backupRelPath,
    originalFingerprint: file.originalFingerprint,
    expectedFingerprint: file.expectedFingerprint,
    status: "pending" as const,
  }));
}

function updateEntriesByRelPath(
  entries: FileRefactorJournalFileEntry[],
  relPath: string,
  status: FileRefactorJournalFileEntry["status"],
  prepared: PreparedRefactorFile[]
): FileRefactorJournalFileEntry[] {
  const match = prepared.find(
    (file) => file.relPath === relPath || file.sourceRelPath === relPath
  );
  const keys = new Set<string>([relPath]);
  if (match?.sourceRelPath) keys.add(match.sourceRelPath);
  if (match) keys.add(match.relPath);
  return entries.map((entry) =>
    keys.has(entry.relPath) ? { ...entry, status } : entry
  );
}

async function runSyncOnly(
  plan: FileRefactorPreviewPlan,
  receipt: FileRefactorRecoveryReceipt,
  deps: ApplyFileRefactorDeps,
  signal?: AbortSignal
): Promise<FileRefactorApplyResult> {
  const stamp = (): number =>
    Math.max((deps.nowMs ?? Date.now)(), receipt.updatedAtMs + 1);

  const syncPending = (): FileRefactorApplyResult => ({
    ...baseResult(plan),
    status: "applied_with_sync_pending",
    reasonCode: "sync_pending",
    filesystem: {
      state: "committed",
      recoveryJournalId: receipt.journalId,
    },
    indexConvergence: {
      state: "pending",
      recoveryInstruction: FILE_REFACTOR_SYNC_PENDING_INSTRUCTION,
    },
  });

  try {
    await deps.syncAfterCommit({ plan, receipt, signal });
    try {
      const converged = await deps.journal.advanceReceipt(receipt.journalId, {
        phase: "converged",
        filesystemState: "committed",
        indexState: "converged",
        updatedAtMs: stamp(),
      });
      return {
        ...baseResult(plan),
        status: "applied",
        filesystem: {
          state: "committed",
          recoveryJournalId: converged.journalId,
        },
        indexConvergence: { state: "converged" },
      };
    } catch {
      return syncPending();
    }
  } catch {
    try {
      await deps.journal.advanceReceipt(receipt.journalId, {
        phase: "sync_pending",
        filesystemState: "committed",
        indexState: "pending",
        updatedAtMs: stamp(),
      });
    } catch {
      /* preserve mutation-free sync-pending result even if journal write fails */
    }
    return syncPending();
  }
}

function recoveryRequiredResult(
  plan: FileRefactorPreviewPlan,
  journalId: string
): FileRefactorApplyResult {
  return {
    ...baseResult(plan),
    status: "failed_rolled_back",
    reasonCode: "rollback_recovery_required",
    filesystem: { state: "recovery_required", recoveryJournalId: journalId },
    indexConvergence: { state: "not_attempted" },
  };
}

function validateApplyRequest(
  plan: FileRefactorPreviewPlan,
  request: FileRefactorApplyRequest
): FileRefactorApplyResult | null {
  if (request.schemaVersion !== FILE_REFACTOR_SCHEMA_VERSION) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }
  if (request.confirmation !== FILE_REFACTOR_APPLY_CONFIRMATION) {
    return unchangedResult(plan, "unsupported", "capability_denied");
  }
  if (request.planDigest !== plan.planDigest) {
    return unchangedResult(plan, "stale_plan", "stale_plan");
  }
  return null;
}

async function validatePlanIntegrity(
  plan: FileRefactorPreviewPlan
): Promise<FileRefactorApplyResult | null> {
  const structural = validateRefactorPlanStructure(plan);
  if (structural) return structural;

  const { planDigest: _ignored, ...material } = plan;
  const recomputed = await computeFileRefactorPlanDigest(material);
  if (recomputed !== plan.planDigest) {
    return unchangedResult(plan, "stale_plan", "stale_plan");
  }
  if (!plan.canApply) {
    const reason =
      plan.safety.blockingReasonCodes[0] ??
      ("capability_denied" as FileRefactorReasonCode);
    return unchangedResult(plan, "unsupported", reason);
  }
  return null;
}

/**
 * Apply an already-produced preview plan with an exact apply request.
 * Never throws for ordinary expected conflicts after partial work.
 */
export async function applyFileRefactor(
  plan: FileRefactorPreviewPlan,
  request: FileRefactorApplyRequest,
  deps: ApplyFileRefactorDeps,
  signal?: AbortSignal
): Promise<FileRefactorApplyResult> {
  const acquire = deps.acquireLock ?? acquireWriteLock;
  const lock = await acquire(deps.lockPath, deps.lockTimeoutMs ?? 5000);
  if (!lock) {
    return unchangedResult(plan, "conflict", "unsafe_target");
  }

  try {
    return await applyUnderLock(plan, request, deps, lock, signal);
  } finally {
    await lock.release();
  }
}

async function applyUnderLock(
  plan: FileRefactorPreviewPlan,
  request: FileRefactorApplyRequest,
  deps: ApplyFileRefactorDeps,
  _lock: WriteLockHandle,
  signal?: AbortSignal
): Promise<FileRefactorApplyResult> {
  const nowMs = deps.nowMs ?? Date.now;

  const requestError = validateApplyRequest(plan, request);
  if (requestError) return requestError;

  const integrityError = await validatePlanIntegrity(plan);
  if (integrityError) return integrityError;

  if (signal?.aborted) {
    return unchangedResult(plan, "conflict", "unsafe_target");
  }

  const existing = await deps.journal.getLatestReceiptByPlanDigest(
    plan.planDigest
  );
  if (existing) {
    if (isUncertainJournalPhase(existing.phase)) {
      return recoveryRequiredResult(plan, existing.journalId);
    }
    if (isCommittedFilesystemPhase(existing.phase)) {
      if (existing.phase === "converged") {
        return {
          ...baseResult(plan),
          status: "applied",
          filesystem: {
            state: "committed",
            recoveryJournalId: existing.journalId,
          },
          indexConvergence: { state: "converged" },
        };
      }
      return runSyncOnly(plan, existing, deps, signal);
    }
    if (existing.phase === "aborted" || existing.phase === "rolled_back") {
      const cleaned = await cleanupReceiptArtifacts(
        deps.collectionRoot,
        existing.fileEntries.map((entry) => entry.stageRelPath),
        existing.fileEntries.map((entry) => entry.backupRelPath),
        deps.removePathRequired ?? removePathRequired
      );
      if (!cleaned) {
        return recoveryRequiredResult(plan, existing.journalId);
      }
      // Fall through to a new clean attempt after artifact cleanup.
    }
  }

  const validated = await validateLiveRefactorPlan(plan, deps.collectionRoot);
  if (!validated.ok) return validated.result;

  if (signal?.aborted) {
    return unchangedResult(plan, "conflict", "unsafe_target");
  }

  const journalIdRaw = (deps.createJournalId ?? (() => crypto.randomUUID()))();
  let journalId: string;
  try {
    journalId = validateRefactorJournalId(journalIdRaw);
  } catch {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }
  const prepared = assignRefactorArtifactPaths(
    validated.files,
    deps.collectionRoot,
    journalId
  );
  let fileEntries = receiptFileEntries(prepared);

  await deps.journal.createPreparedReceipt({
    journalId,
    planDigest: plan.planDigest,
    collection: plan.source.collection,
    operation: plan.operation,
    sourceRelPath: plan.source.relPath,
    targetRelPath: plan.target.relPath,
    fileEntries,
    createdAtMs: nowMs(),
  });

  let staged: StagedRefactorFile[] = [];
  let commitStarted = false;
  let activePhase: "staging" | "committing" | "rolling_back" = "staging";
  let clock = nowMs();
  const nextTs = (): number => {
    clock += 1;
    return clock;
  };

  const fsHooks = {
    onBoundary: deps.onBoundary,
    removePathRequired: deps.removePathRequired,
    collectionRoot: deps.collectionRoot,
    rmdir: deps.rmdir,
    onFileProgress: async (update: {
      relPath: string;
      status: FileRefactorJournalFileEntry["status"];
    }) => {
      fileEntries = updateEntriesByRelPath(
        fileEntries,
        update.relPath,
        update.status,
        prepared
      );
      if (activePhase === "rolling_back") return;
      await deps.journal.advanceReceipt(journalId, {
        phase: activePhase,
        fileEntries,
        updatedAtMs: nextTs(),
      });
    },
  };

  try {
    await deps.journal.advanceReceipt(journalId, {
      phase: "staging",
      updatedAtMs: nextTs(),
    });
    staged = await stageRefactorFiles(prepared, fsHooks, staged);

    if (deps.onBoundary) {
      await deps.onBoundary({ kind: "before_commit" });
    }
    if (signal?.aborted) {
      await rollbackRefactorFiles(staged, false, fsHooks);
      await deps.journal.advanceReceipt(journalId, {
        phase: "aborted",
        filesystemState: "unchanged",
        indexState: "not_attempted",
        updatedAtMs: nextTs(),
      });
      return unchangedResult(plan, "conflict", "unsafe_target", journalId);
    }

    activePhase = "committing";
    await deps.journal.advanceReceipt(journalId, {
      phase: "committing",
      updatedAtMs: nextTs(),
    });
    commitStarted = true;
    await commitRefactorFiles(staged, fsHooks);

    fileEntries = fileEntries.map((entry) => ({
      ...entry,
      status: "committed" as const,
    }));
    await deps.journal.advanceReceipt(journalId, {
      phase: "committed",
      filesystemState: "committed",
      indexState: "not_attempted",
      fileEntries,
      updatedAtMs: nextTs(),
    });
    await cleanupAfterSuccessfulCommit(staged);

    const committedReceipt = await deps.journal.getReceiptById(journalId);
    if (!committedReceipt) {
      return recoveryRequiredResult(plan, journalId);
    }
    return runSyncOnly(plan, committedReceipt, deps, signal);
  } catch {
    let verified = false;
    try {
      activePhase = "rolling_back";
      try {
        await deps.journal.advanceReceipt(journalId, {
          phase: "rolling_back",
          updatedAtMs: nextTs(),
        });
      } catch {
        /* continue rollback even if journal advance fails */
      }
      verified = (await rollbackRefactorFiles(staged, commitStarted, fsHooks))
        .verified;
    } catch {
      verified = false;
    }

    if (verified) {
      try {
        await deps.journal.advanceReceipt(journalId, {
          phase: "rolled_back",
          filesystemState: "rolled_back",
          indexState: "not_attempted",
          fileEntries,
          updatedAtMs: nextTs(),
        });
        return {
          ...baseResult(plan),
          status: "failed_rolled_back",
          reasonCode: "filesystem_commit_failed",
          filesystem: { state: "rolled_back", recoveryJournalId: journalId },
          indexConvergence: { state: "not_attempted" },
        };
      } catch {
        return recoveryRequiredResult(plan, journalId);
      }
    }

    try {
      await deps.journal.advanceReceipt(journalId, {
        phase: "recovery_required",
        filesystemState: "recovery_required",
        indexState: "not_attempted",
        fileEntries,
        updatedAtMs: nextTs(),
      });
    } catch {
      /* still return recovery_required with known journal id */
    }
    return recoveryRequiredResult(plan, journalId);
  }
}
