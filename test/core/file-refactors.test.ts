/**
 * Contract and fixture-matrix tests for reference-safe file refactors.
 *
 * @module test/core/file-refactors
 */

import { describe, expect, test } from "bun:test";

import {
  applyDestinationOnlyEdit,
  buildRefactorWarnings,
  compareExaminedReferences,
  compareUtf16CodeUnits,
  computeFileRefactorPlanDigest,
  deriveCanApply,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_REASON_CODES,
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
  isContentPreservedOutsideSpan,
  planCreateFolder,
  planDuplicateRefactor,
  planMoveRefactor,
  planRenameRefactor,
  sortExaminedReferences,
  stableStringify,
  summarizeReferenceClassifications,
  type FileRefactorApplyRequest,
  type FileRefactorApplyResult,
  type FileRefactorExaminedReference,
  type FileRefactorPreviewPlan,
} from "../../src/core/file-refactors";
import {
  FILE_REFACTOR_FIXTURE_CATEGORIES,
  FILE_REFACTOR_FIXTURE_MATRIX,
  fixtureToExaminedReference,
} from "./file-refactor-fixtures";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

async function buildSamplePreviewPlan(
  overrides: Partial<FileRefactorPreviewPlan> = {}
): Promise<FileRefactorPreviewPlan> {
  const rewriteable = fixtureToExaminedReference(
    FILE_REFACTOR_FIXTURE_MATRIX.find((f) => f.id === "wiki-alias")!
  );
  const opaque = fixtureToExaminedReference(
    FILE_REFACTOR_FIXTURE_MATRIX.find((f) => f.id === "fenced-code-opaque")!
  );
  const examinedReferences = sortExaminedReferences([opaque, rewriteable]);
  const safety = summarizeReferenceClassifications(examinedReferences, {
    backlinks: 1,
    wikiLinks: 1,
    markdownLinks: 0,
  });
  const { planDigest: _ignoredDigest, ...restOverrides } = overrides;
  const withoutDigest: Omit<FileRefactorPreviewPlan, "planDigest"> = {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    operation: "rename",
    conflictPolicy: "fail",
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
    affectedDocuments: [
      {
        uri: "gno://notes/referrer.md",
        relPath: "referrer.md",
        contentFingerprint: HASH_A,
        edits: rewriteable.edit ? [rewriteable.edit] : [],
        examined: [rewriteable],
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
    ...restOverrides,
  };
  const planDigest = await computeFileRefactorPlanDigest(withoutDigest);
  return { ...withoutDigest, planDigest };
}

describe("path planners (compatibility)", () => {
  test("rename/move/duplicate/folder planners and warnings stay compatible", () => {
    expect(
      planRenameRefactor({
        collection: "notes",
        currentRelPath: "folder/old.md",
        nextName: "renamed",
      })
    ).toEqual({
      nextRelPath: "folder/renamed.md",
      nextUri: "gno://notes/folder/renamed.md",
    });
    expect(
      planRenameRefactor({
        collection: "notes",
        currentRelPath: "old.md",
        nextName: "renamed.markdown",
      }).nextRelPath
    ).toBe("renamed.markdown");
    expect(
      planMoveRefactor({
        collection: "notes",
        currentRelPath: "a/old.md",
        folderPath: "archive",
        nextName: "new.md",
      }).nextRelPath
    ).toBe("archive/new.md");
    expect(
      planDuplicateRefactor({
        collection: "notes",
        currentRelPath: "note.md",
        existingRelPaths: ["note.md", "note-2.md"],
      }).nextRelPath
    ).toBe("note-3.md");
    expect(planCreateFolder({ parentPath: "a/b", name: "c" })).toBe("a/b/c");
    expect(() => planCreateFolder({ name: "  " })).toThrow(
      "Folder name cannot be empty"
    );
    const summary = buildRefactorWarnings(
      { backlinks: 2, wikiLinks: 1, markdownLinks: 3 },
      { filenameChanged: true, folderChanged: true }
    );
    expect(summary.warnings.length).toBe(3);
    expect(summary.backlinkCount).toBe(2);
  });
});

describe("reference-safe contract", () => {
  test("schema version, confirmation, and mutation boundary are frozen", () => {
    expect(FILE_REFACTOR_SCHEMA_VERSION).toBe("1.0");
    expect(FILE_REFACTOR_APPLY_CONFIRMATION).toBe("apply");
    expect(FILE_REFACTOR_MUTATION_BOUNDARY).toEqual({
      filesystemCommit: "atomic_all_or_rollback",
      indexConvergence: "post_commit_separate",
      syncFailureDoesNotRollbackFilesystem: true,
    });
    expect(FILE_REFACTOR_REASON_CODES).toContain("ambiguous_resolution");
    expect(FILE_REFACTOR_REASON_CODES).toContain("occupied_target");
    expect(FILE_REFACTOR_REASON_CODES).toContain("sync_pending");
    expect(FILE_REFACTOR_REASON_CODES).toContain(
      "cross_collection_unsupported"
    );
    expect(FILE_REFACTOR_REASON_CODES).toContain("filesystem_commit_failed");
    expect(FILE_REFACTOR_REASON_CODES).toContain("rollback_recovery_required");
  });

  test("plan digest is deterministic and order-sensitive", async () => {
    const first = await buildSamplePreviewPlan();
    const second = await buildSamplePreviewPlan();
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);

    const reordered = await buildSamplePreviewPlan({
      examinedReferences: [...first.examinedReferences].reverse(),
    });
    expect(reordered.planDigest).not.toBe(first.planDigest);
  });

  test("stableStringify matches JSON undefined semantics and rejects non-finite", async () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
    expect(stableStringify([1, undefined, 3])).toBe("[1,null,3]");
    expect(() => stableStringify(Number.NaN)).toThrow(/non-finite/);
    expect(() => stableStringify(Number.POSITIVE_INFINITY)).toThrow(
      /non-finite/
    );
    expect(() => stableStringify(1n)).toThrow(/unsupported/);

    const baseRef: FileRefactorExaminedReference = {
      documentUri: "gno://notes/a.md",
      documentRelPath: "a.md",
      kind: "wiki",
      classification: "unchanged",
    };
    const digestOmitted = await fingerprintUtf8Content(
      stableStringify({
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        examinedReferences: [baseRef],
      })
    );
    const digestExplicit = await fingerprintUtf8Content(
      stableStringify({
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        examinedReferences: [
          {
            ...baseRef,
            reasonCode: undefined,
            originalDestination: undefined,
            edit: undefined,
          },
        ],
      })
    );
    expect(digestOmitted).toBe(digestExplicit);
    const digestMaterial = await fingerprintUtf8Content(
      stableStringify({
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        examinedReferences: [{ ...baseRef, originalDestination: "Old Note" }],
      })
    );
    expect(digestMaterial).not.toBe(digestOmitted);

    const planBase = await buildSamplePreviewPlan();
    const { planDigest: _d1, ...withoutDigest } = planBase;
    const refsOmitted = withoutDigest.examinedReferences.map(
      ({ reasonCode: _r, ...rest }) => rest
    );
    const refsExplicit = withoutDigest.examinedReferences.map((ref) => ({
      ...ref,
      reasonCode: undefined as undefined,
    }));
    const digestPlanOmitted = await computeFileRefactorPlanDigest({
      ...withoutDigest,
      examinedReferences: refsOmitted,
    });
    const digestPlanExplicit = await computeFileRefactorPlanDigest({
      ...withoutDigest,
      examinedReferences: refsExplicit,
    });
    expect(digestPlanOmitted).toBe(digestPlanExplicit);
  });

  test("compareUtf16CodeUnits freezes non-ASCII/case order for sorting", () => {
    expect(compareUtf16CodeUnits("Z", "a")).toBeLessThan(0);
    expect(compareUtf16CodeUnits("cafe", "café")).toBeLessThan(0);
    expect(compareUtf16CodeUnits("Ä", "B")).toBeGreaterThan(0);
    const refs = ["café.md", "Z.md", "a.md"].map((relPath, index) => {
      const examined = fixtureToExaminedReference(
        FILE_REFACTOR_FIXTURE_MATRIX[index]!,
        `gno://notes/${relPath}`,
        relPath
      );
      examined.startLine = 1;
      return examined;
    });
    expect(
      sortExaminedReferences(refs).map((ref) => ref.documentRelPath)
    ).toEqual(["Z.md", "a.md", "café.md"]);
    refs[0]!.startLine = 2;
    refs[1]!.startLine = 1;
    refs[0]!.documentRelPath = "b.md";
    refs[1]!.documentRelPath = "a.md";
    expect(compareExaminedReferences(refs[1]!, refs[0]!)).toBeLessThan(0);
  });

  test("deriveCanApply fails closed for capability, occupancy, and ambiguity", () => {
    const ambiguous = summarizeReferenceClassifications([
      fixtureToExaminedReference(
        FILE_REFACTOR_FIXTURE_MATRIX.find(
          (f) => f.id === "duplicate-basename-ambiguous"
        )!
      ),
    ]);
    const clean = summarizeReferenceClassifications([]);
    expect(
      deriveCanApply({
        safety: ambiguous,
        sourceEditable: true,
        targetOccupied: false,
        sameCollection: true,
      })
    ).toBe(false);
    expect(
      deriveCanApply({
        safety: clean,
        sourceEditable: false,
        targetOccupied: false,
        sameCollection: true,
      })
    ).toBe(false);
    expect(
      deriveCanApply({
        safety: clean,
        sourceEditable: true,
        targetOccupied: true,
        sameCollection: true,
      })
    ).toBe(false);
    expect(
      deriveCanApply({
        safety: clean,
        sourceEditable: true,
        targetOccupied: false,
        sameCollection: false,
      })
    ).toBe(false);
  });

  test("unsupported references block apply; unchanged opaque/external do not", () => {
    for (const id of ["obsidian-embed-unsupported", "html-anchor-opaque"]) {
      const safety = summarizeReferenceClassifications([
        fixtureToExaminedReference(
          FILE_REFACTOR_FIXTURE_MATRIX.find((f) => f.id === id)!
        ),
      ]);
      expect(safety.unsupportedCount).toBe(1);
      expect(safety.blockingReasonCodes.length).toBeGreaterThan(0);
      expect(
        deriveCanApply({
          safety,
          sourceEditable: true,
          targetOccupied: false,
          sameCollection: true,
        })
      ).toBe(false);
    }

    const unsupportedWithoutReason = summarizeReferenceClassifications([
      {
        documentUri: "gno://notes/a.md",
        documentRelPath: "a.md",
        kind: "opaque",
        classification: "unsupported",
      },
    ]);
    expect(unsupportedWithoutReason.blockingReasonCodes).toEqual([
      "unsupported_syntax",
    ]);

    for (const id of [
      "fenced-code-opaque",
      "inline-code-opaque",
      "external-url-unchanged",
    ]) {
      const safety = summarizeReferenceClassifications([
        fixtureToExaminedReference(
          FILE_REFACTOR_FIXTURE_MATRIX.find((f) => f.id === id)!
        ),
      ]);
      expect(safety.unsupportedCount).toBe(0);
      expect(safety.blockingReasonCodes).toEqual([]);
      expect(
        deriveCanApply({
          safety,
          sourceEditable: true,
          targetOccupied: false,
          sameCollection: true,
        })
      ).toBe(true);
    }
  });

  test("apply request requires exact confirmation token", () => {
    const request: FileRefactorApplyRequest = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: HASH_A,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    };
    expect(request.confirmation).toBe("apply");
  });

  test("terminal apply results distinguish FS rollback from sync pending", () => {
    const applied: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "applied",
      planDigest: HASH_A,
      operation: "move",
      source: {
        uri: "gno://notes/a.md",
        relPath: "a.md",
        collection: "notes",
      },
      target: {
        uri: "gno://notes/b/a.md",
        relPath: "b/a.md",
        collection: "notes",
      },
      filesystem: { state: "committed" },
      indexConvergence: { state: "converged" },
    };
    const syncPending: FileRefactorApplyResult = {
      ...applied,
      status: "applied_with_sync_pending",
      reasonCode: "sync_pending",
      indexConvergence: {
        state: "pending",
        recoveryInstruction: "run gno sync --collection notes",
      },
    };
    const rolledBack: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "failed_rolled_back",
      planDigest: HASH_A,
      operation: "move",
      source: applied.source,
      target: applied.target,
      reasonCode: "filesystem_commit_failed",
      filesystem: { state: "rolled_back", recoveryJournalId: "jrnl-1" },
      indexConvergence: { state: "not_attempted" },
    };
    const conflict: FileRefactorApplyResult = {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      status: "conflict",
      planDigest: HASH_A,
      operation: "move",
      source: applied.source,
      target: applied.target,
      reasonCode: "occupied_target",
      filesystem: { state: "unchanged" },
      indexConvergence: { state: "not_attempted" },
    };

    expect(syncPending.filesystem.state).toBe("committed");
    expect(syncPending.indexConvergence.state).toBe("pending");
    expect(rolledBack.filesystem.state).toBe("rolled_back");
    expect(rolledBack.indexConvergence.state).toBe("not_attempted");
    expect(conflict.filesystem.state).toBe("unchanged");
  });
});

describe("fixture matrix", () => {
  test("covers required categories", () => {
    const categories = new Set(
      FILE_REFACTOR_FIXTURE_MATRIX.map((fixture) => fixture.category)
    );
    for (const category of FILE_REFACTOR_FIXTURE_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("rewriteable fixtures preserve non-destination content", async () => {
    for (const fixture of FILE_REFACTOR_FIXTURE_MATRIX) {
      if (fixture.classification !== "rewriteable") continue;
      const examined = fixtureToExaminedReference(fixture);
      expect(examined.edit).toBeDefined();
      const after = applyDestinationOnlyEdit(fixture.content, examined.edit!);
      expect(
        isContentPreservedOutsideSpan(fixture.content, after, examined.edit!)
      ).toBe(true);
      for (const fragment of fixture.mustPreserve) {
        expect(after.includes(fragment)).toBe(true);
      }
      expect(after.includes(fixture.replacementDestination)).toBe(true);
      expect(await fingerprintUtf8Content(after)).not.toBe(
        await fingerprintUtf8Content(fixture.content)
      );
    }
  });

  test("non-rewriteable fixtures keep full content identical by contract", () => {
    for (const fixture of FILE_REFACTOR_FIXTURE_MATRIX) {
      if (fixture.classification === "rewriteable") continue;
      const examined = fixtureToExaminedReference(fixture);
      expect(examined.edit).toBeUndefined();
      for (const fragment of fixture.mustPreserve) {
        expect(fixture.content.includes(fragment)).toBe(true);
      }
      expect(examined.classification).not.toBe("rewriteable");
      expect(examined.reasonCode).toBeDefined();
    }
  });

  test("destination-only edit rejects stale spans", () => {
    const fixture = FILE_REFACTOR_FIXTURE_MATRIX.find(
      (entry) => entry.id === "wiki-alias"
    )!;
    const examined = fixtureToExaminedReference(fixture);
    expect(() =>
      applyDestinationOnlyEdit("totally different content", examined.edit!)
    ).toThrow(/stale or misaligned/);
  });
});
