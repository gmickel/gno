/**
 * DOM coverage for canonical refactor impact preview.
 *
 * @module test/serve/public/components/RefactorImpactPreview.dom.test
 */

import { screen } from "@testing-library/react";
import { describe, expect, mock, test } from "bun:test";

import type { FileRefactorPreviewPlan } from "../../../../src/core/file-refactors";

import {
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "../../../../src/core/file-refactors";
import { renderWithUser } from "../../../helpers/dom";

function samplePlan(
  overrides: Partial<FileRefactorPreviewPlan> = {}
): FileRefactorPreviewPlan {
  return {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    operation: "rename",
    conflictPolicy: "fail",
    source: {
      uri: "gno://notes/old.md",
      relPath: "old.md",
      collection: "notes",
    },
    target: {
      uri: "gno://notes/new.md",
      relPath: "new.md",
      collection: "notes",
    },
    affectedDocuments: [
      {
        uri: "gno://notes/ref.md",
        relPath: "ref.md",
        contentFingerprint: "a".repeat(64),
        edits: [
          {
            coordinateSpace: "utf16_code_units",
            startOffset: 4,
            endOffset: 7,
            originalDestination: "old",
            replacementDestination: "new",
          },
        ],
        examined: [],
      },
    ],
    examinedReferences: [
      {
        documentUri: "gno://notes/ref.md",
        documentRelPath: "ref.md",
        kind: "wiki",
        classification: "rewriteable",
        originalDestination: "old",
        proposedDestination: "new",
        startLine: 1,
        startCol: 5,
      },
      {
        documentUri: "gno://notes/ref.md",
        documentRelPath: "ref.md",
        kind: "opaque",
        classification: "unsupported",
        reasonCode: "code_fence_context",
        originalDestination: "old",
        startLine: 8,
        startCol: 1,
      },
    ],
    preconditions: {
      sourceContentFingerprint: "b".repeat(64),
      affectedContentFingerprints: [
        { uri: "gno://notes/ref.md", fingerprint: "a".repeat(64) },
      ],
      targetPathFingerprint: "c".repeat(64),
    },
    planDigest: "d".repeat(64),
    safety: {
      rewriteableCount: 1,
      unchangedCount: 0,
      ambiguousCount: 0,
      unsupportedCount: 1,
      malformedCount: 0,
      invalidCount: 0,
      blockingReasonCodes: ["unsupported_syntax"],
      warnings: ["Review unsupported references before applying."],
      backlinkCount: 2,
      wikiLinkCount: 1,
      markdownLinkCount: 0,
    },
    canApply: false,
    mutationBoundary: FILE_REFACTOR_MUTATION_BOUNDARY,
    ...overrides,
  };
}

describe("RefactorImpactPreview", () => {
  test("shows affected docs, rewrites, unresolved items, and confirmation gate", async () => {
    const onConfirmedChange = mock(() => undefined);
    const { RefactorImpactPreview } =
      await import("../../../../src/serve/public/components/RefactorImpactPreview");

    const { user } = renderWithUser(
      <RefactorImpactPreview
        confirmed={false}
        onConfirmedChange={onConfirmedChange}
        plan={samplePlan()}
      />
    );

    expect(screen.getByText(/Cannot apply/i)).toBeTruthy();
    expect(screen.getAllByText("ref.md").length).toBeGreaterThan(0);
    expect(screen.getByText(/old → new/)).toBeTruthy();
    expect(screen.getByText(/Unresolved \/ unsupported/i)).toBeTruthy();
    expect(
      screen.getByText(/Review unsupported references before applying/)
    ).toBeTruthy();

    const checkbox = screen.getByRole("checkbox", {
      name: /Confirm exact plan digest/i,
    });
    expect(checkbox).toHaveProperty("disabled", true);

    await user.click(checkbox);
    expect(onConfirmedChange).not.toHaveBeenCalled();
  });

  test("allows confirming a safe plan and surfaces sync-pending outcomes", async () => {
    const onConfirmedChange = mock(() => undefined);
    const { RefactorImpactPreview } =
      await import("../../../../src/serve/public/components/RefactorImpactPreview");

    const { user } = renderWithUser(
      <RefactorImpactPreview
        confirmed={false}
        onConfirmedChange={onConfirmedChange}
        outcomeMessage="File renamed on disk, but index refresh failed."
        outcomeTone="warning"
        plan={samplePlan({
          canApply: true,
          safety: {
            rewriteableCount: 1,
            unchangedCount: 0,
            ambiguousCount: 0,
            unsupportedCount: 0,
            malformedCount: 0,
            invalidCount: 0,
            blockingReasonCodes: [],
            warnings: [],
            backlinkCount: 1,
            wikiLinkCount: 1,
            markdownLinkCount: 0,
          },
          examinedReferences: [
            {
              documentUri: "gno://notes/ref.md",
              documentRelPath: "ref.md",
              kind: "wiki",
              classification: "rewriteable",
              originalDestination: "old",
              proposedDestination: "new",
              startLine: 1,
              startCol: 5,
            },
          ],
        })}
      />
    );

    expect(screen.getByText(/safe to apply/i)).toBeTruthy();
    const checkbox = screen.getByRole("checkbox", {
      name: /Confirm exact plan digest/i,
    });
    expect(checkbox).toHaveProperty("disabled", false);
    await user.click(checkbox);
    expect(onConfirmedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/index refresh failed/)).toBeTruthy();
  });
});
