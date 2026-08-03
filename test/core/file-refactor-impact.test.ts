/**
 * Core rewrite / opaque / ambiguity impact-planner regressions for fn-60.6.
 *
 * @module test/core/file-refactor-impact
 */

import { describe, expect, test } from "bun:test";

import {
  applyDestinationOnlyEdit,
  compareUtf16CodeUnits,
  isContentPreservedOutsideSpan,
  planFileRefactorImpact,
  stableStringify,
} from "../../src/core/file-refactors";

describe("parser-backed reference impact planner", () => {
  test("rewrites unique wiki/markdown/reference-definition spans and preserves bytes", async () => {
    const cases = [
      {
        id: "wiki-alias",
        operation: "rename" as const,
        content: "See [[Old Note|Display Alias]] today.",
        referringRelPath: "referrer.md",
        sourceRelPath: "old-note.md",
        sourceTitle: "Old Note",
        targetRelPath: "new-note.md",
        targetTitle: "New Note",
        expectedTo: "New Note",
        preserve: ["|Display Alias"],
      },
      {
        id: "markdown-label-title",
        operation: "rename" as const,
        content: 'Read [Label Text](old-note.md "Title Text") now.',
        referringRelPath: "referrer.md",
        sourceRelPath: "old-note.md",
        sourceTitle: "Old Note",
        targetRelPath: "new-note.md",
        targetTitle: "New Note",
        expectedTo: "new-note.md",
        preserve: ["[Label Text]", '"Title Text"'],
      },
      {
        id: "markdown-reference-definition",
        operation: "move" as const,
        content: '[ref]: ./old-note.md "def title"\n\nSee [ref][ref].\n',
        referringRelPath: "referrer.md",
        sourceRelPath: "old-note.md",
        sourceTitle: "Old Note",
        targetRelPath: "folder/new-note.md",
        targetTitle: "New Note",
        expectedTo: "./folder/new-note.md",
        preserve: ['"def title"', "[ref][ref]"],
      },
      {
        id: "markdown-relative-path",
        operation: "move" as const,
        content: "Link [x](../old-note.md) please.",
        referringRelPath: "folder/referrer.md",
        sourceRelPath: "old-note.md",
        sourceTitle: "Old Note",
        targetRelPath: "archive/new-note.md",
        targetTitle: "New Note",
        expectedTo: "../archive/new-note.md",
        preserve: ["[x]"],
      },
      {
        id: "percent-encoding",
        operation: "rename" as const,
        content: "Go [here](old%20note.md#frag) end.",
        referringRelPath: "referrer.md",
        sourceRelPath: "old note.md",
        sourceTitle: "Old Note",
        targetRelPath: "new note.md",
        targetTitle: "New Note",
        expectedTo: "new%20note.md",
        preserve: ["#frag", "%20"],
      },
    ] as const;

    for (const entry of cases) {
      const plan = await planFileRefactorImpact({
        operation: entry.operation,
        source: {
          uri: `gno://notes/${entry.sourceRelPath}`,
          relPath: entry.sourceRelPath,
          collection: "notes",
          title: entry.sourceTitle,
          content: `# ${entry.sourceTitle}\n`,
          editable: true,
        },
        target: {
          uri: `gno://notes/${entry.targetRelPath}`,
          relPath: entry.targetRelPath,
          collection: "notes",
          title: entry.targetTitle,
        },
        documents: [
          {
            id: 1,
            uri: `gno://notes/${entry.sourceRelPath}`,
            relPath: entry.sourceRelPath,
            collection: "notes",
            title: entry.sourceTitle,
          },
          {
            id: 2,
            uri: `gno://notes/${entry.referringRelPath}`,
            relPath: entry.referringRelPath,
            collection: "notes",
            title: "Referrer",
            content: entry.content,
          },
        ],
        targetOccupied: false,
      });

      expect(plan.examinedReferences.length).toBe(1);
      const ref = plan.examinedReferences[0]!;
      expect(ref.classification).toBe("rewriteable");
      expect(ref.proposedDestination).toBe(entry.expectedTo);
      expect(ref.edit).toBeDefined();
      const after = applyDestinationOnlyEdit(entry.content, ref.edit!);
      expect(
        isContentPreservedOutsideSpan(entry.content, after, ref.edit!)
      ).toBe(true);
      for (const fragment of entry.preserve) {
        expect(after.includes(fragment)).toBe(true);
      }
      expect(plan.canApply).toBe(true);
    }
  });

  test("classifies opaque and external forms without rewriting", async () => {
    const content = [
      "```md",
      "[[Old Note]]",
      "[fenced](old-note.md)",
      "```",
      "![[Old Note]]",
      '<a href="old-note.md">Old</a>',
      "See [docs](https://example.com/old-note.md).",
      "Broken [[Old Note|alias",
      "Use `[[Old Note]]` and `[inline](old-note.md)` inline.",
      "",
    ].join("\n");

    const plan = await planFileRefactorImpact({
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
        {
          id: 2,
          uri: "gno://notes/referrer.md",
          relPath: "referrer.md",
          collection: "notes",
          title: "Referrer",
          content,
        },
      ],
      targetOccupied: false,
    });

    const byReason = new Map(
      plan.examinedReferences.map((ref) => [ref.reasonCode, ref])
    );
    expect(byReason.get("code_fence_context")?.classification).toBe(
      "unchanged"
    );
    expect(byReason.get("inline_code_context")?.classification).toBe(
      "unchanged"
    );
    expect(
      plan.examinedReferences.filter(
        (ref) => ref.reasonCode === "code_fence_context"
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(
      plan.examinedReferences.filter(
        (ref) => ref.reasonCode === "inline_code_context"
      ).length
    ).toBeGreaterThanOrEqual(2);
    expect(byReason.get("external_destination")?.classification).toBe(
      "unchanged"
    );
    expect(byReason.get("unsupported_syntax")?.classification).toBe(
      "unsupported"
    );
    expect(byReason.get("html_context")?.classification).toBe("unsupported");
    expect(byReason.get("malformed_syntax")?.classification).toBe("malformed");
    expect(plan.examinedReferences.every((ref) => ref.edit === undefined)).toBe(
      true
    );
    expect(plan.canApply).toBe(false);
  });

  test("duplicate basename wiki targets fail closed as ambiguous", async () => {
    const plan = await planFileRefactorImpact({
      operation: "rename",
      source: {
        uri: "gno://notes/a/shared-name.md",
        relPath: "a/shared-name.md",
        collection: "notes",
        title: "Shared Name",
        content: "# Shared Name\n",
        editable: true,
      },
      target: {
        uri: "gno://notes/a/renamed.md",
        relPath: "a/renamed.md",
        collection: "notes",
        title: "Renamed",
      },
      documents: [
        {
          id: 1,
          uri: "gno://notes/a/shared-name.md",
          relPath: "a/shared-name.md",
          collection: "notes",
          title: "Shared Name",
        },
        {
          id: 2,
          uri: "gno://notes/b/shared-name.md",
          relPath: "b/shared-name.md",
          collection: "notes",
          title: "Shared Name",
        },
        {
          id: 3,
          uri: "gno://notes/referrer.md",
          relPath: "referrer.md",
          collection: "notes",
          title: "Referrer",
          content: "See [[Shared Name]] in vault.",
        },
      ],
      targetOccupied: false,
    });

    expect(plan.examinedReferences).toHaveLength(1);
    expect(plan.examinedReferences[0]?.classification).toBe("ambiguous");
    expect(plan.examinedReferences[0]?.reasonCode).toBe(
      "duplicate_basename_ambiguity"
    );
    expect(plan.examinedReferences[0]?.edit).toBeUndefined();
    expect(plan.canApply).toBe(false);
  });

  test("identical snapshots yield identical digests and ordered JSON", async () => {
    const input = {
      operation: "rename" as const,
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
        {
          id: 2,
          uri: "gno://notes/a.md",
          relPath: "a.md",
          collection: "notes",
          title: "A",
          content: "See [[Old Note]] and [x](old-note.md).",
        },
        {
          id: 3,
          uri: "gno://notes/b.md",
          relPath: "b.md",
          collection: "notes",
          title: "B",
          content: "Also [[Old Note#Heading]].",
        },
      ],
      targetOccupied: false,
    };
    const first = await planFileRefactorImpact(input);
    const second = await planFileRefactorImpact(input);
    expect(first.planDigest).toBe(second.planDigest);
    expect(stableStringify(first.examinedReferences)).toBe(
      stableStringify(second.examinedReferences)
    );
    expect(first.examinedReferences.length).toBeGreaterThan(1);
    const paths = first.examinedReferences.map((ref) => ref.documentRelPath);
    expect(paths).toEqual([...paths].sort(compareUtf16CodeUnits));
  });

  test("skips uniquely resolved elsewhere references", async () => {
    const plan = await planFileRefactorImpact({
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
        {
          id: 2,
          uri: "gno://notes/other.md",
          relPath: "other.md",
          collection: "notes",
          title: "Other",
        },
        {
          id: 3,
          uri: "gno://notes/referrer.md",
          relPath: "referrer.md",
          collection: "notes",
          title: "Referrer",
          content: "See [[Other]] and [[Old Note]].",
        },
      ],
      targetOccupied: false,
    });
    expect(plan.examinedReferences).toHaveLength(1);
    expect(plan.examinedReferences[0]?.originalDestination).toBe("Old Note");
    expect(plan.examinedReferences[0]?.classification).toBe("rewriteable");
  });
});
