import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput, DocumentRow } from "../../src/store/types";

import { diagnoseGraphQuery } from "../../src/core/graph-query";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("diagnoseGraphQuery", () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;
  let counter = 0;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-graph-query-"));
    adapter = new SqliteAdapter();
    const open = await adapter.open(join(tmpDir, "test.db"), "porter");
    expect(open.ok).toBe(true);
    const sync = await adapter.syncCollections([
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(sync.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  async function createDoc(
    relPath: string,
    title: string,
    contentType?: string
  ): Promise<DocumentRow> {
    counter += 1;
    const hash = `${counter.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
    const input: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2026-01-01T00:00:00.000Z",
      title,
      mirrorHash: `mirror-${hash}`,
      contentType,
    };
    const upsert = await adapter.upsertDocument(input);
    expect(upsert.ok).toBe(true);
    const doc = await adapter.getDocument("notes", relPath);
    expect(doc.ok).toBe(true);
    if (!doc.ok || !doc.value) {
      throw new Error("document not created");
    }
    return doc.value;
  }

  test("traverses outbound typed edges deterministically with edge filter", async () => {
    const root = await createDoc("root.md", "Root", "meeting");
    const a = await createDoc("a.md", "A");
    const b = await createDoc("b.md", "B");
    await adapter.setDocEdges(
      root.id,
      [
        { targetDocId: b.id, edgeType: "mentions", confidence: "parsed" },
        { targetDocId: a.id, edgeType: "attended", confidence: "manual" },
      ],
      "frontmatter-relation"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      edgeType: "attended",
      contentTypeRules: [
        {
          id: "meeting",
          prefixes: [],
          preset: "meeting",
          graphHints: ["attended", "mentions"],
          searchBoost: 1,
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.root.graphHints).toEqual(["attended", "mentions"]);
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      a.uri,
    ]);
    expect(result.data.edges).toEqual([
      {
        source: root.docid,
        target: a.docid,
        edgeType: "attended",
        relationType: "attended",
        confidence: "manual",
        edgeSource: "frontmatter-relation",
        depth: 1,
      },
    ]);
  });

  test("supports inbound traversal and cycle safety", async () => {
    const root = await createDoc("root.md", "Root");
    const source = await createDoc("source.md", "Source");
    await adapter.setDocEdges(
      source.id,
      [{ targetDocId: root.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: source.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "in",
      maxDepth: 3,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes).toHaveLength(2);
    expect(result.data.meta.truncated).toBe(false);
  });

  test("filters returned edges by inbound direction and dedups provenance", async () => {
    const root = await createDoc("root.md", "Root");
    const source = await createDoc("source.md", "Source");
    const predecessor = await createDoc("predecessor.md", "Predecessor");
    await adapter.setDocEdges(
      source.id,
      [{ targetDocId: root.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      source.id,
      [{ targetDocId: root.id, edgeType: "mentions", confidence: "manual" }],
      "frontmatter-relation"
    );
    await adapter.setDocEdges(
      predecessor.id,
      [{ targetDocId: source.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      source.id,
      [
        {
          targetDocId: predecessor.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
      ],
      "markdown-link"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "in",
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      source.uri,
      predecessor.uri,
    ]);
    expect(result.data.edges).toEqual([
      {
        source: source.docid,
        target: root.docid,
        edgeType: "mentions",
        relationType: "mentions",
        confidence: "manual",
        edgeSource: "frontmatter-relation",
        depth: 1,
      },
      {
        source: predecessor.docid,
        target: source.docid,
        edgeType: "mentions",
        relationType: "mentions",
        confidence: "parsed",
        edgeSource: "wikilink",
        depth: 2,
      },
    ]);
  });

  test("truncates hub traversal at frontier and node caps", async () => {
    const root = await createDoc("root.md", "Root");
    const targets: DocumentRow[] = [];
    for (let i = 0; i < 10; i++) {
      targets.push(await createDoc(`target-${i}.md`, `Target ${i}`));
    }
    await adapter.setDocEdges(
      root.id,
      targets.map((target) => ({
        targetDocId: target.id,
        edgeType: "mentions",
        confidence: "parsed",
      })),
      "wikilink"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      maxNodes: 3,
      frontierLimit: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.truncated).toBe(true);
    expect(result.data.nodes.length).toBeLessThanOrEqual(3);
    expect(result.data.meta.warnings.length).toBeGreaterThan(0);
  });

  test("ignores inactive and duplicate hub edges before frontier warnings", async () => {
    const root = await createDoc("root.md", "Root");
    const stale = await createDoc("aaa-stale.md", "AAA stale");
    const active = await createDoc("zzz-active.md", "ZZZ active");
    await adapter.markInactive("notes", [stale.relPath]);
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: stale.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: active.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      root.id,
      [
        {
          targetDocId: active.id,
          edgeType: "mentions",
          confidence: "manual",
        },
      ],
      "frontmatter-relation"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      frontierLimit: 1,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      active.uri,
    ]);
    expect(result.data.edges).toHaveLength(1);
    expect(result.data.edges[0]?.confidence).toBe("manual");
    expect(result.data.meta.truncated).toBe(false);
    expect(result.data.meta.warnings).not.toContain("frontierLimit reached");
  });

  test("applies cycle filters before bounded edge windows", async () => {
    const root = await createDoc("root.md", "Root");
    const hub = await createDoc("hub.md", "Hub");
    const target = await createDoc("target.md", "Target");
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: hub.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      hub.id,
      [
        { targetDocId: root.id, edgeType: "mentions", confidence: "parsed" },
        { targetDocId: hub.id, edgeType: "mentions", confidence: "parsed" },
        { targetDocId: target.id, edgeType: "mentions", confidence: "parsed" },
      ],
      "wikilink"
    );
    await adapter.setDocEdges(
      hub.id,
      [{ targetDocId: root.id, edgeType: "mentions", confidence: "parsed" }],
      "markdown-link"
    );
    await adapter.setDocEdges(
      hub.id,
      [{ targetDocId: root.id, edgeType: "mentions", confidence: "manual" }],
      "frontmatter-relation"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      frontierLimit: 1,
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      hub.uri,
      target.uri,
    ]);
    expect(result.data.meta.warnings).not.toContain("frontierLimit reached");
  });

  test("ranks unique next nodes before applying frontier slots", async () => {
    const root = await createDoc("root.md", "Root");
    const hub = await createDoc("hub.md", "Hub");
    const first = await createDoc("first.md", "First");
    const second = await createDoc("second.md", "Second");
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: hub.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      hub.id,
      [
        { targetDocId: first.id, edgeType: "aaa", confidence: "parsed" },
        { targetDocId: first.id, edgeType: "aab", confidence: "parsed" },
        { targetDocId: second.id, edgeType: "zzz", confidence: "parsed" },
      ],
      "wikilink"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      frontierLimit: 2,
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      hub.uri,
      first.uri,
      second.uri,
    ]);
    expect(result.data.meta.warnings).not.toContain("frontierLimit reached");
  });

  test("warns when global depth frontier trimming drops nodes", async () => {
    const root = await createDoc("root.md", "Root");
    const firstParent = await createDoc("first-parent.md", "First parent");
    const secondParent = await createDoc("second-parent.md", "Second parent");
    const firstChild = await createDoc("first-child.md", "First child");
    const secondChild = await createDoc("second-child.md", "Second child");
    const thirdChild = await createDoc("third-child.md", "Third child");
    const fourthChild = await createDoc("fourth-child.md", "Fourth child");
    await adapter.setDocEdges(
      root.id,
      [
        {
          targetDocId: firstParent.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
        {
          targetDocId: secondParent.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
      ],
      "wikilink"
    );
    await adapter.setDocEdges(
      firstParent.id,
      [
        {
          targetDocId: firstChild.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
        {
          targetDocId: secondChild.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
      ],
      "wikilink"
    );
    await adapter.setDocEdges(
      secondParent.id,
      [
        {
          targetDocId: thirdChild.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
        {
          targetDocId: fourthChild.id,
          edgeType: "mentions",
          confidence: "parsed",
        },
      ],
      "wikilink"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      frontierLimit: 3,
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.truncated).toBe(true);
    expect(result.data.meta.warnings).toContain("frontierLimit reached");
  });

  test("bounds raw candidate windows by unique next docs", async () => {
    const root = await createDoc("root.md", "Root");
    const hub = await createDoc("hub.md", "Hub");
    const noisy = await createDoc("noisy.md", "Noisy");
    const quiet = await createDoc("quiet.md", "Quiet");
    await adapter.setDocEdges(
      root.id,
      [{ targetDocId: hub.id, edgeType: "mentions", confidence: "parsed" }],
      "wikilink"
    );
    await adapter.setDocEdges(
      hub.id,
      [
        ...Array.from({ length: 9 }, (_, index) => ({
          targetDocId: noisy.id,
          edgeType: `aaa${index}`,
          confidence: "parsed" as const,
        })),
        { targetDocId: quiet.id, edgeType: "zzz", confidence: "parsed" },
      ],
      "wikilink"
    );

    const result = await diagnoseGraphQuery(adapter, root.uri, {
      direction: "out",
      frontierLimit: 2,
      maxDepth: 2,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nodes.map((node) => node.uri)).toEqual([
      root.uri,
      hub.uri,
      noisy.uri,
      quiet.uri,
    ]);
  });
});
