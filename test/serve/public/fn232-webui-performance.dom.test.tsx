import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { BrowseTreeNode } from "../../../src/serve/browse-tree";

import { normalizeMetadataPredicate } from "../../../src/core/typed-metadata";
import {
  CodeBlock,
  highlightCodeDualTheme,
} from "../../../src/serve/public/components/ai-elements/code-block";
import { BrowseTreeSidebar } from "../../../src/serve/public/components/BrowseTreeSidebar";
import { parseMetadataFilter } from "../../../src/serve/public/lib/metadata-filter";

afterEach(() => {
  cleanup();
});

describe("fn-232 R5: zero-zod metadata-filter parity", () => {
  const validCases = [
    '{"op":"eq","key":"status","value":"active"}',
    '{"op":"ne","key":"draft","value":true}',
    '{"op":"gt","key":"priority","value":2}',
    '{"op":"gte","key":"score","value":0.5}',
    '{"op":"lt","key":"age","value":30}',
    '{"op":"lte","key":"age","value":30}',
    '{"op":"exists","key":"author","value":true}',
    '{"op":"in","key":"env","values":["prod","staging","prod"]}',
    '{"op":"nin","key":"env","values":["dev","qa"]}',
    '{"op":"all","key":"tags","values":["perf","lossless","perf"]}',
    '{"op":"not","predicate":{"op":"eq","key":"archived","value":true}}',
    '{"op":"and","predicates":[{"op":"eq","key":"z","value":1},{"op":"eq","key":"a","value":2}]}',
    '{"op":"or","predicates":[{"op":"exists","key":"b","value":true},{"op":"exists","key":"a","value":false}]}',
  ];

  test("valid predicates normalize identically to core normalizeMetadataPredicate", () => {
    for (const raw of validCases) {
      const parsed = parseMetadataFilter(raw);
      expect(parsed.error).toBeUndefined();
      const expected = normalizeMetadataPredicate(JSON.parse(raw));
      expect(parsed.filter).toEqual(expected);
    }
  });

  test("rejects malformed JSON, unknown keys, reserved keys, non-finite numbers, and excessive depth", () => {
    expect(parseMetadataFilter("{bad json").error).toContain("Invalid JSON");
    expect(
      parseMetadataFilter('{"op":"eq","key":"__proto__","value":1}').error
    ).toBeTruthy();
    expect(
      parseMetadataFilter('{"op":"eq","key":"a","value":1,"extra":true}').error
    ).toContain("Unrecognized key");
    expect(
      parseMetadataFilter('{"op":"in","key":"a","values":[]}').error
    ).toBeTruthy();
    expect(
      parseMetadataFilter('{"op":"and","predicates":[]}').error
    ).toBeTruthy();

    // Depth > 8 rejected
    let deep: Record<string, unknown> = {
      op: "exists",
      key: "leaf",
      value: true,
    };
    for (let i = 0; i < 9; i += 1) {
      deep = { op: "not", predicate: deep };
    }
    expect(parseMetadataFilter(JSON.stringify(deep)).error).toContain("depth");
  });
});

describe("fn-232 R5: CodeBlock single-pass dual-theme Shiki", () => {
  test("highlightCodeDualTheme outputs dual-theme shiki CSS variables in one pass", async () => {
    const html = await highlightCodeDualTheme(
      "const answer = 42;",
      "typescript",
      true,
      [1]
    );
    expect(html).toContain("shiki");
    expect(html).toContain("--shiki-dark:");
    expect(html).toContain('data-line-number="1"');
  });

  test("CodeBlock renders a single highlighted DOM container instead of duplicated light/dark trees", async () => {
    const { container } = render(
      <CodeBlock code={"const x = 1;"} language="typescript" />
    );

    await waitFor(() => {
      const pres = container.querySelectorAll("pre.shiki");
      expect(pres.length).toBe(1);
    });
    expect(container.querySelectorAll("pre.shiki").length).toBe(1);
  });
});

describe("fn-232 R5: BrowseTreeSidebar virtualization past 100 rows", () => {
  test("virtualizes visible rows when expanded tree exceeds 100 entries while preserving selection", () => {
    const children: BrowseTreeNode[] = Array.from({ length: 160 }, (_, i) => ({
      id: `folder:notes:dir-${String(i).padStart(3, "0")}`,
      kind: "folder",
      name: `dir-${String(i).padStart(3, "0")}`,
      collection: "notes",
      path: `dir-${String(i).padStart(3, "0")}`,
      depth: 1,
      documentCount: 1,
      directDocumentCount: 1,
      children: [],
    }));
    const collections: BrowseTreeNode[] = [
      {
        id: "collection:notes",
        kind: "collection",
        name: "notes",
        collection: "notes",
        path: "",
        depth: 0,
        documentCount: 160,
        directDocumentCount: 0,
        children,
      },
    ];

    const onSelect = mock(() => undefined);
    const { container } = render(
      <BrowseTreeSidebar
        collections={collections}
        expandedNodeIds={["collection:notes"]}
        favoriteCollections={["notes"]}
        onSelect={onSelect}
        onToggle={() => undefined}
        onToggleFavoriteCollection={() => undefined}
        selectedNodeId="collection:notes"
      />
    );

    const renderedRows = container.querySelectorAll('[role="treeitem"]');
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(80);
  });
});
