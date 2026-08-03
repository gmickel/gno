/**
 * REST transport adapter for canonical reference-safe rename/move.
 *
 * Handlers must not implement link rewrite logic — they only build
 * targets, call the core planner/apply service, and map typed results.
 *
 * @module src/serve/file-refactor-http
 */

import type {
  FileRefactorApplyResult,
  FileRefactorPreviewPlan,
  FileRefactorReasonCode,
} from "../core/file-refactors";

import {
  applyCanonicalFileRefactor,
  buildCanonicalRefactorPlan,
  buildDurableFileRefactorApplyDeps,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  parseRefactorApplyConfirmation as parseCoreRefactorApplyConfirmation,
  resolveMoveTarget,
  resolveRenameTarget,
} from "../core/file-refactors";

export {
  applyCanonicalFileRefactor,
  buildCanonicalRefactorPlan,
  buildDurableFileRefactorApplyDeps as buildFileRefactorApplyDeps,
  resolveMoveTarget,
  resolveRenameTarget,
};

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

function warningsFromPlan(plan: FileRefactorPreviewPlan) {
  return {
    warnings: [...plan.safety.warnings],
    backlinkCount: plan.safety.backlinkCount,
    wikiLinkCount: plan.safety.wikiLinkCount,
    markdownLinkCount: plan.safety.markdownLinkCount,
  };
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
  const parsed = parseCoreRefactorApplyConfirmation(body);
  if ("error" in parsed) {
    return { code: "VALIDATION", message: parsed.message, status: 400 };
  }
  return parsed;
}
