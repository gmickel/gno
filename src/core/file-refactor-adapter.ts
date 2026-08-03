/**
 * Transport-neutral SDK/MCP adapter for canonical reference-safe rename/move.
 *
 * Surfaces must not implement link rewrite logic — they resolve targets, call
 * the core planner/apply service, and expose typed content-free results.
 * Do not import from `src/serve` (REST remains a separate adapter).
 *
 * @module src/core/file-refactor-adapter
 */

// node:path join — no Bun path utils
import { join } from "node:path";

import type { Collection } from "../config/types";
import type { DocumentRow } from "../store/types";
import type {
  FileRefactorApplyResult,
  FileRefactorOperation,
  FileRefactorPreviewPlan,
  FileRefactorReasonCode,
} from "./file-refactor-contract";
import type { FileRefactorSnapshotLike } from "./file-refactor-from-snapshot";
import type { ApplyFileRefactorDeps } from "./file-refactor-service";

import { isRefactorFingerprint } from "./file-refactor-apply-safety";
import {
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "./file-refactor-contract";
import { planFileRefactorImpactFromSnapshot } from "./file-refactor-from-snapshot";
import { planMoveRefactor, planRenameRefactor } from "./file-refactor-paths";
import { planFileRefactorImpact } from "./file-refactor-planner";
import {
  applyFileRefactor,
  journalPortFromStore,
} from "./file-refactor-service";

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
  store: Partial<{
    getFileRefactorResolutionSnapshot: (input: {
      sourceUri: string;
    }) => Promise<{
      ok: boolean;
      value?: FileRefactorSnapshotLike;
      error?: { message: string };
    }>;
  }> &
    object;
  sourceEditable?: boolean;
}

export interface ParsedRefactorApplyConfirmation {
  planDigest: string;
  confirmation: typeof FILE_REFACTOR_APPLY_CONFIRMATION;
  schemaVersion: typeof FILE_REFACTOR_SCHEMA_VERSION;
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
      throw new Error(
        snapshotResult.error?.message ?? "Failed to load refactor snapshot"
      );
    }
    if (!snapshotResult.value) {
      throw new Error("Refactor resolution snapshot was empty");
    }
    return planFileRefactorImpactFromSnapshot({
      operation: input.operation,
      snapshot: snapshotResult.value,
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

/**
 * Production apply deps — durable journal only. Never falls back to memory.
 */
export function buildDurableFileRefactorApplyDeps(input: {
  collection: Collection;
  store: object;
  syncAfterCommit: ApplyFileRefactorDeps["syncAfterCommit"];
}): ApplyFileRefactorDeps {
  if (!storeHasJournalPort(input.store)) {
    throw new Error(
      "Durable file-refactor journal store is unavailable on this adapter"
    );
  }
  return {
    collectionRoot: input.collection.path,
    lockPath: collectionRefactorLockPath(input.collection.path),
    journal: journalPortFromStore(input.store),
    syncAfterCommit: input.syncAfterCommit,
  };
}

export function parseRefactorApplyConfirmation(body: {
  planDigest?: unknown;
  confirmation?: unknown;
  schemaVersion?: unknown;
}): ParsedRefactorApplyConfirmation | { error: string; message: string } {
  if (
    typeof body.planDigest !== "string" ||
    !isRefactorFingerprint(body.planDigest)
  ) {
    return {
      error: "INVALID_INPUT",
      message: "planDigest must be a 64-character lowercase SHA-256 digest",
    };
  }
  if (body.confirmation !== FILE_REFACTOR_APPLY_CONFIRMATION) {
    return {
      error: "INVALID_INPUT",
      message: `confirmation must be "${FILE_REFACTOR_APPLY_CONFIRMATION}"`,
    };
  }
  if (body.schemaVersion !== FILE_REFACTOR_SCHEMA_VERSION) {
    return {
      error: "INVALID_INPUT",
      message: `schemaVersion must be "${FILE_REFACTOR_SCHEMA_VERSION}"`,
    };
  }

  return {
    planDigest: body.planDigest,
    confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
  };
}

/**
 * A collection sync that reports file failures is not convergence. Throwing
 * lets the apply service preserve the durable commit as sync-pending.
 */
export function assertFileRefactorSyncConverged(result: {
  filesErrored?: number;
  errors?: readonly unknown[];
}): void {
  if ((result.filesErrored ?? 0) > 0 || (result.errors?.length ?? 0) > 0) {
    throw new Error("File-refactor index convergence reported sync errors");
  }
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
