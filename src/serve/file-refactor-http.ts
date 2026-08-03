/**
 * REST transport adapter for canonical reference-safe rename/move.
 *
 * Handlers must not implement link rewrite logic — they only build
 * targets, call the core planner/apply service, and map typed results.
 *
 * @module src/serve/file-refactor-http
 */

// node:path join — no Bun path utils
import { join } from "node:path";

import type { Collection } from "../config/types";
import type {
  ApplyFileRefactorDeps,
  FileRefactorApplyResult,
  FileRefactorOperation,
  FileRefactorPreviewPlan,
  FileRefactorReasonCode,
  FileRefactorSnapshotLike,
} from "../core/file-refactors";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentRow } from "../store/types";

import {
  applyFileRefactor,
  createMemoryFileRefactorJournal,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  journalPortFromStore,
  planFileRefactorImpact,
  planFileRefactorImpactFromSnapshot,
  planMoveRefactor,
  planRenameRefactor,
} from "../core/file-refactors";

export const FILE_REFACTOR_COLLECTION_LOCK_NAME = ".gno-refactor.lock";

export interface FileRefactorPathTarget {
  nextRelPath: string;
  nextUri: string;
}

export interface BuildCanonicalRefactorPlanInput {
  operation: FileRefactorOperation;
  doc: Pick<
    DocumentRow,
    "id" | "uri" | "relPath" | "collection" | "title" | "mirrorHash"
  >;
  collection: Collection;
  /** Absolute path of the live source file. */
  sourceFullPath: string;
  target: FileRefactorPathTarget;
  store: Partial<Pick<SqliteAdapter, "getFileRefactorResolutionSnapshot">> &
    object;
  sourceEditable?: boolean;
}

export interface FileRefactorHttpError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export interface FileRefactorApplyHttpSuccess {
  success: true;
  uri: string;
  path: string;
  relPath: string;
  planDigest: string;
  status: FileRefactorApplyResult["status"];
  apply: FileRefactorApplyResult;
  refactorWarnings: {
    warnings: string[];
    backlinkCount: number;
    wikiLinkCount: number;
    markdownLinkCount: number;
  };
  warning?: string;
}

export function collectionRefactorLockPath(collectionRoot: string): string {
  return join(collectionRoot, FILE_REFACTOR_COLLECTION_LOCK_NAME);
}

export function resolveRenameTarget(input: {
  collection: string;
  currentRelPath: string;
  nextName: string;
}): FileRefactorPathTarget {
  return planRenameRefactor(input);
}

export function resolveMoveTarget(input: {
  collection: string;
  currentRelPath: string;
  folderPath: string;
  nextName?: string;
}): FileRefactorPathTarget {
  return planMoveRefactor(input);
}

function warningsFromPlan(plan: FileRefactorPreviewPlan) {
  return {
    warnings: [...plan.safety.warnings],
    backlinkCount: plan.safety.backlinkCount,
    wikiLinkCount: plan.safety.wikiLinkCount,
    markdownLinkCount: plan.safety.markdownLinkCount,
  };
}

async function targetOccupiedOnDisk(
  collectionRoot: string,
  targetRelPath: string,
  sourceRelPath: string
): Promise<boolean> {
  if (targetRelPath === sourceRelPath) {
    return false;
  }
  return Bun.file(join(collectionRoot, targetRelPath)).exists();
}

async function buildPlanFromLiveDisk(
  input: BuildCanonicalRefactorPlanInput,
  occupied: boolean
): Promise<FileRefactorPreviewPlan> {
  const content = await Bun.file(input.sourceFullPath).text();
  return planFileRefactorImpact({
    operation: input.operation,
    source: {
      uri: input.doc.uri,
      relPath: input.doc.relPath,
      collection: input.doc.collection,
      title: input.doc.title,
      content,
      editable: input.sourceEditable ?? true,
    },
    target: {
      uri: input.target.nextUri,
      relPath: input.target.nextRelPath,
      collection: input.collection.name,
      title: input.doc.title,
    },
    documents: [
      {
        id: input.doc.id,
        uri: input.doc.uri,
        relPath: input.doc.relPath,
        collection: input.doc.collection,
        title: input.doc.title,
        active: true,
      },
    ],
    targetOccupied: occupied,
  });
}

/**
 * Build the canonical preview plan for rename/move.
 * Prefers the store resolution snapshot; falls back to live disk content
 * when the snapshot seam is unavailable (focused unit tests / stubs).
 */
export async function buildCanonicalRefactorPlan(
  input: BuildCanonicalRefactorPlanInput
): Promise<FileRefactorPreviewPlan> {
  const occupied = await targetOccupiedOnDisk(
    input.collection.path,
    input.target.nextRelPath,
    input.doc.relPath
  );

  const snapshotFn = input.store.getFileRefactorResolutionSnapshot;
  if (typeof snapshotFn === "function") {
    const snapshotResult = await snapshotFn.call(input.store, {
      sourceUri: input.doc.uri,
    });
    if (!snapshotResult.ok) {
      throw new Error(snapshotResult.error.message);
    }
    const snapshot = snapshotResult.value as FileRefactorSnapshotLike;
    return planFileRefactorImpactFromSnapshot({
      operation: input.operation,
      snapshot,
      target: {
        uri: input.target.nextUri,
        relPath: input.target.nextRelPath,
        collection: input.collection.name,
        title: input.doc.title,
      },
      targetOccupied: occupied,
      sourceEditable: input.sourceEditable,
    });
  }

  return buildPlanFromLiveDisk(input, occupied);
}

export function toRefactorPlanResponse(plan: FileRefactorPreviewPlan) {
  return {
    ...plan,
    operation: plan.operation,
    nextRelPath: plan.target.relPath,
    nextUri: plan.target.uri,
    refactorWarnings: warningsFromPlan(plan),
  };
}

function storeHasJournalPort(
  store: object
): store is Parameters<typeof journalPortFromStore>[0] {
  const candidate = store as Record<string, unknown>;
  return (
    typeof candidate.createFileRefactorPreparedReceipt === "function" &&
    typeof candidate.advanceFileRefactorReceipt === "function" &&
    typeof candidate.getFileRefactorReceiptById === "function" &&
    typeof candidate.getLatestFileRefactorReceiptByPlanDigest === "function"
  );
}

export function buildFileRefactorApplyDeps(input: {
  collection: Collection;
  store: object;
  syncAfterCommit: ApplyFileRefactorDeps["syncAfterCommit"];
}): ApplyFileRefactorDeps {
  return {
    collectionRoot: input.collection.path,
    lockPath: collectionRefactorLockPath(input.collection.path),
    journal: storeHasJournalPort(input.store)
      ? journalPortFromStore(input.store)
      : createMemoryFileRefactorJournal(),
    syncAfterCommit: input.syncAfterCommit,
  };
}

function reasonMessage(
  status: FileRefactorApplyResult["status"],
  reasonCode?: FileRefactorReasonCode
): string {
  switch (status) {
    case "stale_plan":
      return "This refactor plan is stale. Preview again, then confirm the exact plan digest.";
    case "conflict":
      return "Another workspace mutation is in progress or the target is unsafe. Retry after it finishes.";
    case "unsupported":
      if (
        reasonCode === "capability_denied" ||
        reasonCode === "read_only_document"
      ) {
        return "This document cannot be refactored in place from GNO.";
      }
      if (reasonCode === "occupied_target") {
        return "A file with that name already exists at the destination";
      }
      return reasonCode
        ? `Refactor cannot be applied (${reasonCode}).`
        : "Refactor cannot be applied.";
    case "failed_rolled_back":
      if (reasonCode === "rollback_recovery_required") {
        return "Refactor failed and needs recovery. Filesystem state may require manual inspection using the recovery journal id.";
      }
      return "Refactor failed and was rolled back. No partial file set was left behind.";
    default:
      return "Refactor failed.";
  }
}

export function mapApplyResultToHttpError(
  result: FileRefactorApplyResult
): FileRefactorHttpError {
  const reasonCode = "reasonCode" in result ? result.reasonCode : undefined;
  const details: Record<string, unknown> = {
    planDigest: result.planDigest,
    status: result.status,
    filesystem: result.filesystem,
    indexConvergence: result.indexConvergence,
  };
  if (reasonCode) {
    details.reasonCode = reasonCode;
  }
  if (result.filesystem.recoveryJournalId) {
    details.recoveryJournalId = result.filesystem.recoveryJournalId;
  }

  if (result.status === "stale_plan") {
    return {
      code: "STALE_PLAN",
      message: reasonMessage(result.status, reasonCode),
      status: 409,
      details,
    };
  }
  if (result.status === "conflict") {
    return {
      code: "CONFLICT",
      message: reasonMessage(result.status, reasonCode),
      status: 409,
      details,
    };
  }
  if (result.status === "unsupported") {
    if (
      reasonCode === "capability_denied" ||
      reasonCode === "read_only_document"
    ) {
      return {
        code: "READ_ONLY",
        message: reasonMessage(result.status, reasonCode),
        status: 409,
        details,
      };
    }
    if (reasonCode === "occupied_target") {
      return {
        code: "CONFLICT",
        message: reasonMessage(result.status, reasonCode),
        status: 409,
        details,
      };
    }
    return {
      code: "UNSUPPORTED",
      message: reasonMessage(result.status, reasonCode),
      status: 409,
      details,
    };
  }
  if (result.status === "failed_rolled_back") {
    const recovery =
      result.filesystem.state === "recovery_required" ||
      reasonCode === "rollback_recovery_required";
    return {
      code: recovery ? "RECOVERY_REQUIRED" : "ROLLED_BACK",
      message: reasonMessage(result.status, reasonCode),
      status: 500,
      details,
    };
  }

  return {
    code: "RUNTIME",
    message: reasonMessage(result.status, reasonCode),
    status: 500,
    details,
  };
}

export function mapApplyResultToHttpSuccess(input: {
  plan: FileRefactorPreviewPlan;
  result: FileRefactorApplyResult;
  targetFullPath: string;
  operationLabel: "renamed" | "moved";
}): FileRefactorApplyHttpSuccess | FileRefactorHttpError {
  const { plan, result, targetFullPath, operationLabel } = input;

  if (
    result.status !== "applied" &&
    result.status !== "applied_with_sync_pending"
  ) {
    return mapApplyResultToHttpError(result);
  }

  const warning =
    result.status === "applied_with_sync_pending"
      ? `File ${operationLabel} on disk, but index refresh failed. Run Update All to reconcile the workspace.`
      : undefined;

  return {
    success: true,
    uri: plan.target.uri,
    path: targetFullPath,
    relPath: plan.target.relPath,
    planDigest: result.planDigest,
    status: result.status,
    apply: result,
    refactorWarnings: warningsFromPlan(plan),
    warning,
  };
}

export interface ParsedRefactorApplyConfirmation {
  planDigest: string;
  confirmation: typeof FILE_REFACTOR_APPLY_CONFIRMATION;
  schemaVersion: typeof FILE_REFACTOR_SCHEMA_VERSION;
}

export function parseRefactorApplyConfirmation(body: {
  planDigest?: unknown;
  confirmation?: unknown;
  schemaVersion?: unknown;
}): ParsedRefactorApplyConfirmation | FileRefactorHttpError {
  if (typeof body.planDigest !== "string" || !body.planDigest.trim()) {
    return {
      code: "VALIDATION",
      message: "planDigest must be a non-empty string",
      status: 400,
    };
  }
  if (body.confirmation !== FILE_REFACTOR_APPLY_CONFIRMATION) {
    return {
      code: "VALIDATION",
      message: `confirmation must be "${FILE_REFACTOR_APPLY_CONFIRMATION}"`,
      status: 400,
    };
  }
  if (body.schemaVersion !== FILE_REFACTOR_SCHEMA_VERSION) {
    return {
      code: "VALIDATION",
      message: `schemaVersion must be "${FILE_REFACTOR_SCHEMA_VERSION}"`,
      status: 400,
    };
  }

  return {
    planDigest: body.planDigest.trim(),
    confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
  };
}

/**
 * Apply a rename/move through the canonical service.
 * The supplied digest must match the freshly computed plan. Callers must
 * preview first; apply never silently manufactures confirmation.
 */
export async function applyCanonicalFileRefactor(input: {
  plan: FileRefactorPreviewPlan;
  confirmation: ParsedRefactorApplyConfirmation;
  deps: ApplyFileRefactorDeps;
  signal?: AbortSignal;
}): Promise<FileRefactorApplyResult> {
  const { plan, confirmation, deps, signal } = input;

  if (confirmation.planDigest !== plan.planDigest) {
    return {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: plan.planDigest,
      operation: plan.operation,
      source: plan.source,
      target: plan.target,
      status: "stale_plan",
      reasonCode: "stale_plan",
      filesystem: { state: "unchanged" },
      indexConvergence: { state: "not_attempted" },
    };
  }

  if (!plan.canApply) {
    const targetAbs = join(deps.collectionRoot, plan.target.relPath);
    const occupied =
      plan.target.relPath !== plan.source.relPath &&
      (await Bun.file(targetAbs).exists());
    const reason =
      plan.safety.blockingReasonCodes[0] ??
      (occupied
        ? ("occupied_target" as FileRefactorReasonCode)
        : ("capability_denied" as FileRefactorReasonCode));
    const status =
      reason === "occupied_target" || reason === "unsafe_target"
        ? ("conflict" as const)
        : ("unsupported" as const);
    return {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: plan.planDigest,
      operation: plan.operation,
      source: plan.source,
      target: plan.target,
      status,
      reasonCode: reason,
      filesystem: { state: "unchanged" },
      indexConvergence: { state: "not_attempted" },
    };
  }

  return applyFileRefactor(
    plan,
    {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: plan.planDigest,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    },
    deps,
    signal
  );
}
