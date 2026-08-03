/**
 * Focused planner / inventory regressions for fn-60.6 host-review fixes.
 *
 * @module test/core/file-refactor-planner
 */

import { describe, expect, test } from "bun:test";

import { FILE_REFACTOR_PLANNER_CAPS } from "../../src/core/file-refactor-planner-types";
import { resolveWikiTarget } from "../../src/core/file-refactor-resolve";
import {
  applyDestinationOnlyEdit,
  isContentPreservedOutsideSpan,
  planFileRefactorImpact,
  planFileRefactorImpactFromSnapshot,
  planInputFromResolutionSnapshot,
  type FileRefactorPlannerDocument,
  type FileRefactorSnapshotLike,
  type PlanFileRefactorImpactInput,
} from "../../src/core/file-refactors";
import {
  buildSourceRelevanceKeys,
  dedupeInventoryDestinationTokens,
  inventoryDocumentLinks,
  isRelevantDestination,
  type LinkInventoryToken,
} from "../../src/core/link-inventory";

function baseInput(
  overrides: Partial<PlanFileRefactorImpactInput> & {
    documents?: FileRefactorPlannerDocument[];
  } = {}
): PlanFileRefactorImpactInput {
  return {
    operation: "rename",
    source: {
      uri: "gno://notes/old-note.md",
      relPath: "old-note.md",
      collection: "notes",
      title: "Old Note",
      content: "# Old Note\n",
      editable: true,
    },
    target: {
      uri: "gno://notes/new-note.md",
      relPath: "new-note.md",
      collection: "notes",
      title: "New Note",
    },
    documents: [
      {
        id: 1,
        uri: "gno://notes/old-note.md",
        relPath: "old-note.md",
        collection: "notes",
        title: "Old Note",
      },
    ],
    targetOccupied: false,
    ...overrides,
  };
}

describe("self-references", () => {
  test("inventories source self-links exactly once with one fingerprint", async () => {
    const plan = await planFileRefactorImpact(
      baseInput({
        source: {
          uri: "gno://notes/old-note.md",
          relPath: "old-note.md",
          collection: "notes",
          title: "Old Note",
          content: "See [[Old Note#Section]] and [self](old-note.md).\n",
          editable: true,
        },
      })
    );
    const selfRefs = plan.examinedReferences.filter(
      (ref) => ref.documentUri === "gno://notes/old-note.md"
    );
    expect(selfRefs.length).toBe(2);
    expect(selfRefs.every((ref) => ref.classification === "rewriteable")).toBe(
      true
    );
    const fingerprints = plan.preconditions.affectedContentFingerprints.filter(
      (entry) => entry.uri === "gno://notes/old-note.md"
    );
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]?.fingerprint).toBe(
      plan.preconditions.sourceContentFingerprint
    );
    expect(plan.canApply).toBe(true);
  });
});

describe("editable capability", () => {
  test("blocks rewrite for uniquely resolved read-only referrer", async () => {
    const plan = await planFileRefactorImpact(
      baseInput({
        documents: [
          {
            id: 1,
            uri: "gno://notes/old-note.md",
            relPath: "old-note.md",
            collection: "notes",
            title: "Old Note",
          },
          {
            id: 2,
            uri: "gno://notes/record.md",
            relPath: "record.md",
            collection: "notes",
            title: "Record",
            content: "See [[Old Note]].",
            editable: false,
            editableReason: "read_only_document",
          },
        ],
      })
    );
    expect(plan.examinedReferences).toHaveLength(1);
    expect(plan.examinedReferences[0]?.classification).toBe("unsupported");
    expect(plan.examinedReferences[0]?.reasonCode).toBe("read_only_document");
    expect(plan.examinedReferences[0]?.edit).toBeUndefined();
    expect(plan.canApply).toBe(false);
  });
});

describe("input validation", () => {
  test("target traversal and mismatched URI fail closed without throwing", async () => {
    const traversal = await planFileRefactorImpact(
      baseInput({
        target: {
          uri: "gno://notes/../escape.md",
          relPath: "../escape.md",
          collection: "notes",
        },
      })
    );
    expect(traversal.canApply).toBe(false);
    expect(traversal.examinedReferences[0]?.reasonCode).toBe("unsafe_target");
    expect(traversal.examinedReferences[0]?.originalDestination).toContain(
      "path_traversal"
    );

    const mismatch = await planFileRefactorImpact(
      baseInput({
        target: {
          uri: "gno://notes/other.md",
          relPath: "new-note.md",
          collection: "notes",
        },
      })
    );
    expect(mismatch.canApply).toBe(false);
    expect(mismatch.examinedReferences[0]?.originalDestination).toBe(
      "target_uri_path_mismatch"
    );

    const noOp = await planFileRefactorImpact(
      baseInput({
        target: {
          uri: "gno://notes/old-note.md",
          relPath: "old-note.md",
          collection: "notes",
        },
      })
    );
    expect(noOp.canApply).toBe(false);
    expect(noOp.examinedReferences[0]?.originalDestination).toBe(
      "source_matches_target"
    );
  });
});

describe("relevance exactness", () => {
  test("unrelated other-note.md HTML/embed/code does not match note.md", () => {
    const keys = buildSourceRelevanceKeys({
      relPath: "note.md",
      title: "Note",
    });
    expect(isRelevantDestination("other-note.md", keys)).toBe(false);
    expect(isRelevantDestination("note.md", keys)).toBe(true);

    const inventory = inventoryDocumentLinks(
      [
        '<a href="other-note.md">x</a>',
        "![[other-note]]",
        "```",
        "[[other-note]]",
        "```",
        "See [[Note]].",
      ].join("\n"),
      { sourceKeys: keys }
    );
    expect(
      inventory.tokens.every((token) =>
        ["Note", "note", "note.md"].some((part) =>
          token.originalDestination.toLowerCase().includes(part.toLowerCase())
        )
      )
    ).toBe(true);
    expect(
      inventory.tokens.some((token) =>
        token.originalDestination.toLowerCase().includes("other")
      )
    ).toBe(false);
  });

  test("unrelated other-note.md occurrences do not block renaming note.md", async () => {
    const plan = await planFileRefactorImpact(
      baseInput({
        source: {
          uri: "gno://notes/note.md",
          relPath: "note.md",
          collection: "notes",
          title: "Note",
          content: "# Note\n",
          editable: true,
        },
        target: {
          uri: "gno://notes/renamed.md",
          relPath: "renamed.md",
          collection: "notes",
          title: "Renamed",
        },
        documents: [
          {
            id: 1,
            uri: "gno://notes/note.md",
            relPath: "note.md",
            collection: "notes",
            title: "Note",
          },
          {
            id: 2,
            uri: "gno://notes/referrer.md",
            relPath: "referrer.md",
            collection: "notes",
            title: "Referrer",
            content: [
              '<a href="other-note.md">x</a>',
              "![[other-note]]",
              "See [[Note]].",
            ].join("\n"),
          },
        ],
      })
    );
    expect(
      plan.examinedReferences.every(
        (ref) => !ref.originalDestination?.toLowerCase().includes("other")
      )
    ).toBe(true);
    expect(plan.examinedReferences.some((ref) => ref.edit)).toBe(true);
    expect(plan.canApply).toBe(true);
  });
});

describe("markdown destination preservation", () => {
  test("preserves escaped parens/spaces, percent forms, query+fragment+title", async () => {
    const cases = [
      {
        content: 'Go [x](old\\ note.md#frag "Title") end.',
        sourceRelPath: "old note.md",
        targetRelPath: "new note.md",
        expected: "new\\ note.md",
        preserve: ["#frag", '"Title"'],
      },
      {
        content: "Go [x](foo\\(bar\\).md?q=1#h) end.",
        sourceRelPath: "foo(bar).md",
        targetRelPath: "baz(qux).md",
        expected: "baz\\(qux\\).md",
        preserve: ["?q=1", "#h"],
      },
      {
        content: 'Go [x](foo(bar).md "T") end.',
        sourceRelPath: "foo(bar).md",
        targetRelPath: "baz(qux).md",
        expected: "baz(qux).md",
        preserve: ['"T"'],
      },
      {
        content: 'Go [x](old%20note.md?q=1#frag "T") end.',
        sourceRelPath: "old note.md",
        targetRelPath: "new note.md",
        expected: "new%20note.md",
        preserve: ["?q=1", "#frag", '"T"'],
      },
      {
        content: 'Go [x](<old note.md#frag> "T") end.',
        sourceRelPath: "old note.md",
        targetRelPath: "new note.md",
        expected: "new note.md",
        preserve: ["<", ">", "#frag", '"T"'],
      },
      {
        content: '[ref]: old\\ note.md "def"\n\nSee [ref][ref].\n',
        sourceRelPath: "old note.md",
        targetRelPath: "new note.md",
        expected: "new\\ note.md",
        preserve: ['"def"', "[ref][ref]"],
      },
    ] as const;

    for (const entry of cases) {
      const plan = await planFileRefactorImpact(
        baseInput({
          source: {
            uri: `gno://notes/${entry.sourceRelPath}`,
            relPath: entry.sourceRelPath,
            collection: "notes",
            title: "Old Note",
            content: "# Old Note\n",
            editable: true,
          },
          target: {
            uri: `gno://notes/${entry.targetRelPath}`,
            relPath: entry.targetRelPath,
            collection: "notes",
            title: "New Note",
          },
          documents: [
            {
              id: 1,
              uri: `gno://notes/${entry.sourceRelPath}`,
              relPath: entry.sourceRelPath,
              collection: "notes",
              title: "Old Note",
            },
            {
              id: 2,
              uri: "gno://notes/referrer.md",
              relPath: "referrer.md",
              collection: "notes",
              title: "Referrer",
              content: entry.content,
            },
          ],
        })
      );
      expect(plan.examinedReferences.length).toBeGreaterThanOrEqual(1);
      const ref = plan.examinedReferences.find(
        (row) => row.classification === "rewriteable"
      );
      expect(ref?.proposedDestination).toBe(entry.expected);
      expect(ref?.edit).toBeDefined();
      const after = applyDestinationOnlyEdit(entry.content, ref!.edit!);
      expect(
        isContentPreservedOutsideSpan(entry.content, after, ref!.edit!)
      ).toBe(true);
      for (const fragment of entry.preserve) {
        expect(after.includes(fragment)).toBe(true);
      }
    }
  });
});

describe("resolution caps", () => {
  test("evaluates more than old 64-candidate cap without silent truncate", () => {
    const catalog = Array.from({ length: 80 }, (_, index) => ({
      id: index + 1,
      uri: `gno://notes/folder-${index}/shared.md`,
      relPath: `folder-${index}/shared.md`,
      collection: "notes",
      title: "Shared",
    }));
    const resolution = resolveWikiTarget({
      targetRef: "Shared",
      targetCollection: "notes",
      sourceUri: catalog[0]!.uri,
      catalog,
    });
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.matchCount).toBeGreaterThan(64);
  });

  test("truncationReasons input forces canApply=false", async () => {
    const plan = await planFileRefactorImpact(
      baseInput({
        truncationReasons: ["referrers_truncated"],
        documents: [
          {
            id: 1,
            uri: "gno://notes/old-note.md",
            relPath: "old-note.md",
            collection: "notes",
            title: "Old Note",
          },
          {
            id: 2,
            uri: "gno://notes/referrer.md",
            relPath: "referrer.md",
            collection: "notes",
            title: "Referrer",
            content: "See [[Old Note]].",
          },
        ],
      })
    );
    expect(plan.canApply).toBe(false);
    expect(
      plan.safety.warnings.some((warning) =>
        warning.includes("referrers_truncated")
      )
    ).toBe(true);
  });
});

describe("overlap / dedup", () => {
  test("emits each destination token once", () => {
    const keys = buildSourceRelevanceKeys({
      relPath: "old-note.md",
      title: "Old Note",
    });
    const inventory = inventoryDocumentLinks("See [[Old Note]] once.\n", {
      sourceKeys: keys,
    });
    expect(inventory.tokens).toHaveLength(1);
    expect(inventory.overlapping).toBe(false);
  });

  test("dedupes identical destination spans across scanner kinds", () => {
    const duplicateA: LinkInventoryToken = {
      kind: "wiki",
      raw: "[[Old Note]]",
      originalDestination: "Old Note",
      destinationStart: 10,
      destinationEnd: 18,
      startOffset: 8,
      endOffset: 20,
      startLine: 1,
      startCol: 9,
      endLine: 1,
      endCol: 21,
      targetRef: "Old Note",
      hadLeadingDotSlash: false,
      encodingStyle: {
        spaces: "raw",
        parens: "raw",
        angleBrackets: false,
      },
    };
    const duplicateB: LinkInventoryToken = {
      ...duplicateA,
      kind: "markdown",
      raw: "[x](Old Note)",
      classification: "unchanged",
      reasonCode: "code_fence_context",
    };
    const partialOverlap: LinkInventoryToken = {
      ...duplicateA,
      kind: "opaque",
      destinationStart: 15,
      destinationEnd: 25,
      originalDestination: "Note]]xx",
      startOffset: 15,
      endOffset: 25,
    };
    const deduped = dedupeInventoryDestinationTokens([duplicateA, duplicateB]);
    expect(deduped.tokens).toHaveLength(1);
    expect(deduped.tokens[0]?.kind).toBe("wiki");
    expect(deduped.overlapping).toBe(false);

    const overlapped = dedupeInventoryDestinationTokens([
      duplicateA,
      partialOverlap,
    ]);
    expect(overlapped.tokens).toHaveLength(2);
    expect(overlapped.overlapping).toBe(true);
  });
});

describe("code-context markdown / embed / HTML", () => {
  test("reports inline and fenced markdown destinations as opaque unchanged", () => {
    const keys = buildSourceRelevanceKeys({
      relPath: "old-note.md",
      title: "Old Note",
    });
    const inventory = inventoryDocumentLinks(
      [
        "Inline `[label](old-note.md)` stays.",
        "```",
        "[ref](old-note.md)",
        "```",
        "Live [ok](old-note.md).",
      ].join("\n"),
      { sourceKeys: keys }
    );
    const codeTokens = inventory.tokens.filter(
      (token) =>
        token.reasonCode === "inline_code_context" ||
        token.reasonCode === "code_fence_context"
    );
    expect(codeTokens).toHaveLength(2);
    expect(
      codeTokens.every(
        (token) =>
          token.classification === "unchanged" &&
          token.originalDestination === "old-note.md"
      )
    ).toBe(true);
    expect(
      inventory.tokens.filter(
        (token) =>
          token.kind === "markdown" && token.classification === undefined
      )
    ).toHaveLength(1);
  });

  test("classifies embed and HTML inside code as code context, not unsupported", () => {
    const keys = buildSourceRelevanceKeys({
      relPath: "old-note.md",
      title: "Old Note",
    });
    const inventory = inventoryDocumentLinks(
      [
        "```",
        "![[Old Note]]",
        '<a href="old-note.md">x</a>',
        "```",
        "Live ![[Old Note]]",
      ].join("\n"),
      { sourceKeys: keys }
    );
    const fence = inventory.tokens.filter(
      (token) => token.reasonCode === "code_fence_context"
    );
    expect(fence.length).toBeGreaterThanOrEqual(2);
    expect(fence.every((token) => token.classification === "unchanged")).toBe(
      true
    );
    expect(
      inventory.tokens.some(
        (token) =>
          token.reasonCode === "unsupported_syntax" &&
          token.originalDestination === "Old Note"
      )
    ).toBe(true);
    expect(
      inventory.tokens.some((token) => token.reasonCode === "html_context")
    ).toBe(false);
  });
});

describe("path canonicality", () => {
  test("rejects backslash and dot-component source/target paths", async () => {
    const backslash = await planFileRefactorImpact(
      baseInput({
        target: {
          uri: "gno://notes/folder\\note.md",
          relPath: "folder\\note.md",
          collection: "notes",
        },
      })
    );
    expect(backslash.canApply).toBe(false);
    expect(backslash.examinedReferences[0]?.originalDestination).toContain(
      "backslash_path"
    );

    const dotComponent = await planFileRefactorImpact(
      baseInput({
        target: {
          uri: "gno://notes/folder/./note.md",
          relPath: "folder/./note.md",
          collection: "notes",
        },
      })
    );
    expect(dotComponent.canApply).toBe(false);
    expect(dotComponent.examinedReferences[0]?.originalDestination).toContain(
      "dot_component"
    );
  });
});

describe("bounded catalog inventory", () => {
  test("catalog overflow truncates without inventoring unbounded docs", async () => {
    const max = FILE_REFACTOR_PLANNER_CAPS.maxCatalogDocuments;
    const documents: FileRefactorPlannerDocument[] = Array.from(
      { length: max + 1 },
      (_, index) => ({
        id: index + 1,
        uri: `gno://notes/n${index}.md`,
        relPath: `n${index}.md`,
        collection: "notes",
        title: `N${index}`,
      })
    );
    // Source is n0; put a content hit only on the overflow document.
    documents[max] = {
      ...documents[max]!,
      content: "See [[Old Note]] beyond catalog cap.",
    };
    const plan = await planFileRefactorImpact(
      baseInput({
        documents: [
          {
            id: 0,
            uri: "gno://notes/old-note.md",
            relPath: "old-note.md",
            collection: "notes",
            title: "Old Note",
          },
          ...documents,
        ],
      })
    );
    expect(
      plan.safety.warnings.some((warning) =>
        warning.includes("catalog_truncated")
      )
    ).toBe(true);
    expect(plan.canApply).toBe(false);
    expect(
      plan.examinedReferences.some(
        (ref) => ref.documentRelPath === `n${max}.md`
      )
    ).toBe(false);
  });
});

describe("from-snapshot null source content", () => {
  function nullSourceSnapshot(
    overrides: Partial<FileRefactorSnapshotLike> = {}
  ): FileRefactorSnapshotLike {
    return {
      source: {
        id: 1,
        uri: "gno://notes/no-mirror.md",
        relPath: "no-mirror.md",
        collection: "notes",
        title: "No Mirror",
        content: null,
        contentTruncated: false,
        editable: true,
      },
      catalog: [
        {
          id: 1,
          uri: "gno://notes/no-mirror.md",
          relPath: "no-mirror.md",
          collection: "notes",
          title: "No Mirror",
        },
      ],
      referrers: [],
      // Legacy/custom seam: truncated false and no reason despite null content.
      truncated: false,
      truncationReasons: [],
      ...overrides,
    };
  }

  test("planInputFromResolutionSnapshot adds source_content_missing for null source content", () => {
    const input = planInputFromResolutionSnapshot({
      operation: "rename",
      snapshot: nullSourceSnapshot(),
      target: {
        uri: "gno://notes/renamed.md",
        relPath: "renamed.md",
        collection: "notes",
        title: "Renamed",
      },
      targetOccupied: false,
    });
    expect(input.truncationReasons).toContain("source_content_missing");
    // Adapter seam still coerces to string for the planner body field.
    expect(input.source.content).toBe("");
  });

  test("null source content cannot apply and is not treated as complete empty body", async () => {
    const plan = await planFileRefactorImpactFromSnapshot({
      operation: "rename",
      snapshot: nullSourceSnapshot(),
      target: {
        uri: "gno://notes/renamed.md",
        relPath: "renamed.md",
        collection: "notes",
        title: "Renamed",
      },
      targetOccupied: false,
    });
    expect(plan.canApply).toBe(false);
    expect(
      plan.safety.warnings.some((warning) =>
        warning.includes("source_content_missing")
      )
    ).toBe(true);
    // Empty-string coercion must not look like a known complete source body.
    expect(plan.safety.blockingReasonCodes.length).toBeGreaterThan(0);
  });
});
