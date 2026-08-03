/**
 * Contract tests for file-refactor preview/apply JSON schemas.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import applyResultSchema from "../../../spec/output-schemas/file-refactor-apply-result.schema.json";
import previewSchema from "../../../spec/output-schemas/file-refactor-preview.schema.json";
import {
  computeFileRefactorPlanDigest,
  deriveCanApply,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_SCHEMA_VERSION,
  sortExaminedReferences,
  summarizeReferenceClassifications,
  type FileRefactorApplyResult,
  type FileRefactorPreviewPlan,
} from "../../../src/core/file-refactors";
import {
  FILE_REFACTOR_FIXTURE_MATRIX,
  fixtureToExaminedReference,
} from "../../core/file-refactor-fixtures";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(previewSchema);
ajv.addSchema(applyResultSchema);
const validatePreview = ajv.compile(previewSchema);
const validateApply = ajv.compile(applyResultSchema);

const DOC = {
  source: {
    uri: "gno://notes/old-note.md",
    relPath: "old-note.md",
    collection: "notes",
  },
  target: {
    uri: "gno://notes/new-note.md",
    relPath: "new-note.md",
    collection: "notes",
  },
} as const;

async function samplePreview(): Promise<FileRefactorPreviewPlan> {
  const rewriteable = fixtureToExaminedReference(
    FILE_REFACTOR_FIXTURE_MATRIX.find((f) => f.id === "wiki-alias")!
  );
  const examinedReferences = sortExaminedReferences([rewriteable]);
  const safety = summarizeReferenceClassifications(examinedReferences);
  const withoutDigest: Omit<FileRefactorPreviewPlan, "planDigest"> = {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    operation: "rename",
    conflictPolicy: "fail",
    source: DOC.source,
    target: DOC.target,
    affectedDocuments: [
      {
        uri: "gno://notes/referrer.md",
        relPath: "referrer.md",
        contentFingerprint: HASH_A,
        edits: rewriteable.edit ? [rewriteable.edit] : [],
        examined: examinedReferences,
      },
    ],
    examinedReferences,
    preconditions: {
      sourceContentFingerprint: HASH_B,
      affectedContentFingerprints: [
        { uri: "gno://notes/referrer.md", fingerprint: HASH_A },
      ],
      targetPathFingerprint: HASH_C,
    },
    safety,
    canApply: deriveCanApply({
      safety,
      sourceEditable: true,
      targetOccupied: false,
      sameCollection: true,
    }),
    mutationBoundary: FILE_REFACTOR_MUTATION_BOUNDARY,
  };
  return {
    ...withoutDigest,
    planDigest: await computeFileRefactorPlanDigest(withoutDigest),
  };
}

describe("file-refactor-preview schema", () => {
  test("registers required metadata", async () => {
    const loaded = await loadSchema("file-refactor-preview");
    expect(loaded).toMatchObject({
      $id: "gno://schemas/file-refactor-preview@1.0",
      title: "GNO File Refactor Preview Plan",
      additionalProperties: false,
    });
  });

  test("accepts a closed preview plan", async () => {
    const plan = await samplePreview();
    expect(validatePreview(plan)).toBe(true);
    expect(assertValid(plan, await loadSchema("file-refactor-preview"))).toBe(
      true
    );
  });

  test("rejects extension fields and unknown reason codes", async () => {
    const plan = await samplePreview();
    const schema = await loadSchema("file-refactor-preview");
    expect(validatePreview({ ...plan, unexpected: true })).toBe(false);
    expect(
      validatePreview({
        ...plan,
        safety: {
          ...plan.safety,
          blockingReasonCodes: ["not_a_real_code"],
        },
      })
    ).toBe(false);
    expect(assertInvalid({ ...plan, schemaVersion: "2.0" }, schema)).toBe(true);
  });
});

describe("file-refactor-apply-result schema", () => {
  test("registers required metadata", async () => {
    const loaded = await loadSchema("file-refactor-apply-result");
    expect(loaded).toMatchObject({
      $id: "gno://schemas/file-refactor-apply-result@1.0",
      title: "GNO File Refactor Apply Result",
      additionalProperties: false,
    });
  });

  test("accepts valid terminal status combinations", () => {
    const applied: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "applied",
      planDigest: HASH_A,
      operation: "rename",
      source: DOC.source,
      target: DOC.target,
      filesystem: { state: "committed" },
      indexConvergence: { state: "converged" },
    };
    expect(validateApply(applied)).toBe(true);

    const pending: FileRefactorApplyResult = {
      ...applied,
      status: "applied_with_sync_pending",
      reasonCode: "sync_pending",
      indexConvergence: {
        state: "pending",
        recoveryInstruction: "run gno sync --collection notes",
      },
    };
    expect(validateApply(pending)).toBe(true);

    const conflict: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "conflict",
      planDigest: HASH_A,
      operation: "rename",
      source: DOC.source,
      target: DOC.target,
      reasonCode: "occupied_target",
      filesystem: { state: "unchanged" },
      indexConvergence: { state: "not_attempted" },
    };
    expect(validateApply(conflict)).toBe(true);

    const stale: FileRefactorApplyResult = {
      ...conflict,
      status: "stale_plan",
      reasonCode: "stale_plan",
      indexConvergence: { state: "skipped" },
    };
    expect(validateApply(stale)).toBe(true);

    const unsupported: FileRefactorApplyResult = {
      ...conflict,
      status: "unsupported",
      reasonCode: "unsupported_syntax",
    };
    expect(validateApply(unsupported)).toBe(true);

    const rolledBack: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "failed_rolled_back",
      planDigest: HASH_A,
      operation: "rename",
      source: DOC.source,
      target: DOC.target,
      reasonCode: "filesystem_commit_failed",
      filesystem: { state: "rolled_back", recoveryJournalId: "jrnl-1" },
      indexConvergence: { state: "not_attempted" },
    };
    expect(validateApply(rolledBack)).toBe(true);

    const recovery: FileRefactorApplyResult = {
      ...rolledBack,
      reasonCode: "rollback_recovery_required",
      filesystem: { state: "recovery_required", recoveryJournalId: "jrnl-2" },
      indexConvergence: { state: "skipped" },
    };
    expect(validateApply(recovery)).toBe(true);
    expect(FILE_REFACTOR_APPLY_CONFIRMATION).toBe("apply");
  });

  test("rejects impossible status/state combinations", () => {
    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "applied",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        reasonCode: "sync_pending",
        filesystem: { state: "committed" },
        indexConvergence: { state: "converged" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "applied",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        filesystem: { state: "committed" },
        indexConvergence: { state: "pending" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "applied_with_sync_pending",
        planDigest: HASH_A,
        operation: "move",
        source: DOC.source,
        target: DOC.target,
        filesystem: { state: "committed" },
        indexConvergence: {
          state: "pending",
          recoveryInstruction: "sync",
        },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "applied_with_sync_pending",
        planDigest: HASH_A,
        operation: "move",
        source: DOC.source,
        target: DOC.target,
        reasonCode: "sync_pending",
        filesystem: { state: "committed" },
        indexConvergence: { state: "pending" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "conflict",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        reasonCode: "occupied_target",
        filesystem: { state: "committed" },
        indexConvergence: { state: "not_attempted" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "stale_plan",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        reasonCode: "stale_plan",
        filesystem: { state: "unchanged" },
        indexConvergence: { state: "converged" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "failed_rolled_back",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        filesystem: { state: "rolled_back" },
        indexConvergence: { state: "not_attempted" },
      })
    ).toBe(false);

    expect(
      validateApply({
        schemaVersion: "1.0",
        status: "failed_rolled_back",
        planDigest: HASH_A,
        operation: "rename",
        source: DOC.source,
        target: DOC.target,
        reasonCode: "filesystem_commit_failed",
        filesystem: { state: "unchanged" },
        indexConvergence: { state: "not_attempted" },
      })
    ).toBe(false);
  });

  test("rejects extra fields on filesystem receipt", async () => {
    const schema = await loadSchema("file-refactor-apply-result");
    expect(
      assertInvalid(
        {
          schemaVersion: "1.0",
          status: "applied",
          planDigest: HASH_A,
          operation: "rename",
          source: DOC.source,
          target: DOC.target,
          filesystem: { state: "committed", noteBody: "secret" },
          indexConvergence: { state: "converged" },
        },
        schema
      )
    ).toBe(true);
  });
});
