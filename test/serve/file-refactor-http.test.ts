import { describe, expect, test } from "bun:test";

import type {
  FileRefactorApplyResult,
  FileRefactorPreviewPlan,
} from "../../src/core/file-refactors";

import {
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "../../src/core/file-refactors";
import {
  mapApplyResultToHttpError,
  mapApplyResultToHttpSuccess,
  parseRefactorApplyConfirmation,
} from "../../src/serve/file-refactor-http";

const source = {
  uri: "gno://notes/old.md",
  relPath: "old.md",
  collection: "notes",
};
const target = {
  uri: "gno://notes/new.md",
  relPath: "new.md",
  collection: "notes",
};

type WithoutResultBase<T> = T extends unknown
  ? Omit<T, "schemaVersion" | "planDigest" | "operation" | "source" | "target">
  : never;

function result(
  value: WithoutResultBase<FileRefactorApplyResult>
): FileRefactorApplyResult {
  return {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    planDigest: "d".repeat(64),
    operation: "rename",
    source,
    target,
    ...value,
  } as FileRefactorApplyResult;
}

const plan = {
  schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
  operation: "rename",
  conflictPolicy: "fail",
  source,
  target,
  affectedDocuments: [],
  examinedReferences: [],
  preconditions: {
    sourceContentFingerprint: "a".repeat(64),
    affectedContentFingerprints: [],
    targetPathFingerprint: "b".repeat(64),
  },
  planDigest: "d".repeat(64),
  safety: {
    rewriteableCount: 0,
    unchangedCount: 0,
    ambiguousCount: 0,
    unsupportedCount: 0,
    malformedCount: 0,
    invalidCount: 0,
    blockingReasonCodes: [],
    warnings: [],
    backlinkCount: 0,
    wikiLinkCount: 0,
    markdownLinkCount: 0,
  },
  canApply: true,
  mutationBoundary: FILE_REFACTOR_MUTATION_BOUNDARY,
} satisfies FileRefactorPreviewPlan;

describe("file refactor HTTP adapter", () => {
  test("requires the complete explicit apply confirmation", () => {
    expect(parseRefactorApplyConfirmation({})).toEqual(
      expect.objectContaining({ code: "VALIDATION", status: 400 })
    );
    expect(
      parseRefactorApplyConfirmation({
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      })
    ).toEqual(expect.objectContaining({ code: "VALIDATION", status: 400 }));
    expect(
      parseRefactorApplyConfirmation({
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      })
    ).toEqual({
      planDigest: plan.planDigest,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    });
  });

  test("maps stale, conflict, and denied outcomes without losing typed state", () => {
    const stale = mapApplyResultToHttpError(
      result({
        status: "stale_plan",
        reasonCode: "stale_plan",
        filesystem: { state: "unchanged" },
        indexConvergence: { state: "not_attempted" },
      })
    );
    expect(stale).toEqual(
      expect.objectContaining({ code: "STALE_PLAN", status: 409 })
    );
    expect(stale.details?.status).toBe("stale_plan");

    const conflict = mapApplyResultToHttpError(
      result({
        status: "conflict",
        reasonCode: "occupied_target",
        filesystem: { state: "unchanged" },
        indexConvergence: { state: "not_attempted" },
      })
    );
    expect(conflict.code).toBe("CONFLICT");

    const denied = mapApplyResultToHttpError(
      result({
        status: "unsupported",
        reasonCode: "read_only_document",
        filesystem: { state: "unchanged" },
        indexConvergence: { state: "not_attempted" },
      })
    );
    expect(denied).toEqual(
      expect.objectContaining({ code: "READ_ONLY", status: 409 })
    );
  });

  test("distinguishes verified rollback from recovery-required", () => {
    const rolledBack = mapApplyResultToHttpError(
      result({
        status: "failed_rolled_back",
        reasonCode: "unsafe_target",
        filesystem: { state: "rolled_back", recoveryJournalId: "journal-1" },
        indexConvergence: { state: "not_attempted" },
      })
    );
    expect(rolledBack.code).toBe("ROLLED_BACK");

    const recovery = mapApplyResultToHttpError(
      result({
        status: "failed_rolled_back",
        reasonCode: "rollback_recovery_required",
        filesystem: {
          state: "recovery_required",
          recoveryJournalId: "journal-2",
        },
        indexConvergence: { state: "not_attempted" },
      })
    );
    expect(recovery.code).toBe("RECOVERY_REQUIRED");
    expect(recovery.details?.recoveryJournalId).toBe("journal-2");
  });

  test("treats sync pending as committed success with recovery guidance", () => {
    const mapped = mapApplyResultToHttpSuccess({
      plan,
      result: result({
        status: "applied_with_sync_pending",
        reasonCode: "sync_pending",
        filesystem: { state: "committed", recoveryJournalId: "journal-3" },
        indexConvergence: {
          state: "pending",
          recoveryInstruction: "Run gno update.",
        },
      }),
      targetFullPath: "/vault/new.md",
      operationLabel: "renamed",
    });
    expect(mapped).toEqual(
      expect.objectContaining({
        success: true,
        status: "applied_with_sync_pending",
        relPath: "new.md",
      })
    );
    expect("warning" in mapped ? mapped.warning : undefined).toContain(
      "index refresh failed"
    );
  });
});
