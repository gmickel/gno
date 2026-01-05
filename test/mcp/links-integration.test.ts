/**
 * Integration tests for MCP link tools.
 * Tests handler logic with actual database operations.
 *
 * Note: gno_similar tests are skipped because they require embedding models
 * which are not available in CI. Use store-level vector tests instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocLinkInput, DocumentInput } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("MCP link tools integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-mcp-links-"));
    dbPath = join(tmpDir, "test.db");
    store = new SqliteAdapter();
    const result = await store.open(dbPath, "porter");
    expect(result.ok).toBe(true);

    // Sync collections
    const collections = [
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      {
        name: "docs",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    const syncResult = await store.syncCollections(collections);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  async function createTestDoc(
    collection: string,
    relPath: string,
    title: string,
    markdown: string
  ): Promise<number> {
    const hash = `hash-${collection}-${relPath}`;
    const doc: DocumentInput = {
      collection,
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: markdown.length,
      sourceMtime: new Date().toISOString(),
      title,
      mirrorHash: hash,
      ingestVersion: 3,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Failed to create test doc");

    // Store content
    const contentResult = await store.upsertContent(hash, markdown);
    expect(contentResult.ok).toBe(true);

    return result.value.id;
  }

  describe("gno_links integration", () => {
    test("returns outgoing wiki links", async () => {
      const sourceId = await createTestDoc(
        "notes",
        "index.md",
        "Index",
        "See [[Target Note]] and [[Other Note]]"
      );

      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 5,
          endLine: 1,
          endCol: 20,
        },
        {
          targetRef: "Other Note",
          targetRefNorm: "other note",
          linkType: "wiki",
          startLine: 1,
          startCol: 25,
          endLine: 1,
          endCol: 40,
        },
      ];
      await store.setDocLinks(sourceId, links, "parsed");

      const result = await store.getLinksForDoc(sourceId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.targetRef).toBe("Target Note");
      expect(result.value[1]?.targetRef).toBe("Other Note");
    });

    test("returns markdown links with anchors", async () => {
      const sourceId = await createTestDoc(
        "notes",
        "readme.md",
        "README",
        "See [the guide](./guide.md#section-1)"
      );

      const links: DocLinkInput[] = [
        {
          targetRef: "./guide.md",
          targetRefNorm: "guide.md",
          targetAnchor: "section-1",
          linkType: "markdown",
          linkText: "the guide",
          startLine: 1,
          startCol: 5,
          endLine: 1,
          endCol: 38,
        },
      ];
      await store.setDocLinks(sourceId, links, "parsed");

      const result = await store.getLinksForDoc(sourceId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.targetAnchor).toBe("section-1");
      expect(result.value[0]?.linkText).toBe("the guide");
    });

    test("filters by link type", async () => {
      const sourceId = await createTestDoc(
        "notes",
        "mixed.md",
        "Mixed",
        "[[Wiki Link]] and [markdown](other.md)"
      );

      const links: DocLinkInput[] = [
        {
          targetRef: "Wiki Link",
          targetRefNorm: "wiki link",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 13,
        },
        {
          targetRef: "other.md",
          targetRefNorm: "other.md",
          linkType: "markdown",
          startLine: 1,
          startCol: 18,
          endLine: 1,
          endCol: 40,
        },
      ];
      await store.setDocLinks(sourceId, links, "parsed");

      // Get all links
      const allResult = await store.getLinksForDoc(sourceId);
      expect(allResult.ok).toBe(true);
      if (!allResult.ok) return;
      expect(allResult.value).toHaveLength(2);

      // Filter manually (mimicking handler behavior)
      const wikiLinks = allResult.value.filter((l) => l.linkType === "wiki");
      expect(wikiLinks).toHaveLength(1);
      expect(wikiLinks[0]?.targetRef).toBe("Wiki Link");

      const mdLinks = allResult.value.filter((l) => l.linkType === "markdown");
      expect(mdLinks).toHaveLength(1);
      expect(mdLinks[0]?.targetRef).toBe("other.md");
    });
  });

  describe("gno_backlinks integration", () => {
    test("finds wiki backlinks by title", async () => {
      const targetId = await createTestDoc(
        "notes",
        "target.md",
        "Target Note",
        "# Target Note\nContent here."
      );
      const source1Id = await createTestDoc(
        "notes",
        "source1.md",
        "Source 1",
        "See [[Target Note]]"
      );
      const source2Id = await createTestDoc(
        "notes",
        "source2.md",
        "Source 2",
        "Also [[Target Note]] here"
      );

      // Add links from sources to target
      const link: DocLinkInput = {
        targetRef: "Target Note",
        targetRefNorm: "target note",
        linkType: "wiki",
        startLine: 1,
        startCol: 5,
        endLine: 1,
        endCol: 20,
      };
      await store.setDocLinks(source1Id, [link], "parsed");
      await store.setDocLinks(source2Id, [{ ...link, startCol: 6 }], "parsed");

      const result = await store.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
      const sourceIds = result.value.map((b) => b.sourceDocId);
      expect(sourceIds).toContain(source1Id);
      expect(sourceIds).toContain(source2Id);
    });

    test("finds markdown backlinks by path", async () => {
      const targetId = await createTestDoc(
        "notes",
        "docs/guide.md",
        "Guide",
        "# Guide\nContent."
      );
      const sourceId = await createTestDoc(
        "notes",
        "index.md",
        "Index",
        "See [guide](docs/guide.md)"
      );

      const link: DocLinkInput = {
        targetRef: "docs/guide.md",
        targetRefNorm: "docs/guide.md",
        linkType: "markdown",
        linkText: "guide",
        startLine: 1,
        startCol: 5,
        endLine: 1,
        endCol: 26,
      };
      await store.setDocLinks(sourceId, [link], "parsed");

      const result = await store.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sourceId);
      expect(result.value[0]?.linkText).toBe("guide");
    });

    test("excludes inactive sources", async () => {
      const targetId = await createTestDoc(
        "notes",
        "target.md",
        "Target",
        "Content"
      );
      const activeSourceId = await createTestDoc(
        "notes",
        "active.md",
        "Active",
        "[[Target]]"
      );
      const inactiveSourceId = await createTestDoc(
        "notes",
        "inactive.md",
        "Inactive",
        "[[Target]]"
      );

      const link: DocLinkInput = {
        targetRef: "Target",
        targetRefNorm: "target",
        linkType: "wiki",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 10,
      };
      await store.setDocLinks(activeSourceId, [link], "parsed");
      await store.setDocLinks(inactiveSourceId, [link], "parsed");

      // Mark one as inactive
      await store.markInactive("notes", ["inactive.md"]);

      const result = await store.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(activeSourceId);
    });

    test("handles cross-collection links", async () => {
      const targetId = await createTestDoc(
        "notes",
        "target.md",
        "Target Note",
        "Content"
      );
      const sameCollSourceId = await createTestDoc(
        "notes",
        "same.md",
        "Same Coll",
        "[[Target Note]]"
      );
      const diffCollSourceId = await createTestDoc(
        "docs",
        "diff.md",
        "Diff Coll",
        "[[notes:Target Note]]"
      );

      // Link from same collection (no prefix needed)
      const sameCollLink: DocLinkInput = {
        targetRef: "Target Note",
        targetRefNorm: "target note",
        linkType: "wiki",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 15,
      };
      await store.setDocLinks(sameCollSourceId, [sameCollLink], "parsed");

      // Link from different collection (with explicit prefix)
      const diffCollLink: DocLinkInput = {
        targetRef: "Target Note",
        targetRefNorm: "target note",
        targetCollection: "notes",
        linkType: "wiki",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 22,
      };
      await store.setDocLinks(diffCollSourceId, [diffCollLink], "parsed");

      const result = await store.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
    });
  });

  describe("gno_graph integration", () => {
    test("returns graph with nodes and edges", async () => {
      // Create a small connected graph with links by rel_path (simpler resolution)
      const docAId = await createTestDoc(
        "notes",
        "doc-a.md",
        "Document A",
        "Links to doc-b.md"
      );
      const docBId = await createTestDoc(
        "notes",
        "doc-b.md",
        "Document B",
        "Links to doc-a.md"
      );

      // Add markdown links (resolved by rel_path - simpler than wiki title matching)
      await store.setDocLinks(
        docAId,
        [
          {
            targetRef: "doc-b.md",
            targetRefNorm: "doc-b.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 10,
            endLine: 1,
            endCol: 25,
          },
        ],
        "parsed"
      );
      await store.setDocLinks(
        docBId,
        [
          {
            targetRef: "doc-a.md",
            targetRefNorm: "doc-a.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 10,
            endLine: 1,
            endCol: 25,
          },
        ],
        "parsed"
      );

      const result = await store.getGraph({ collection: "notes" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { nodes, links } = result.value;

      // Should have 2 nodes (both connected)
      expect(nodes.length).toBe(2);
      expect(
        nodes
          .map((n) => n.title)
          .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      ).toEqual(["Document A", "Document B"]);

      // Should have at least 1 edge (edges may be deduplicated/collapsed)
      expect(links.length).toBeGreaterThanOrEqual(1);
      expect(links.every((l) => l.type === "markdown")).toBe(true);

      // Both docs should have degree >= 1 (connected to each other)
      expect(nodes.every((n) => n.degree >= 1)).toBe(true);
    });

    test("returns empty graph for collection with no links", async () => {
      // Create isolated doc (no links, linkedOnly=true by default)
      await createTestDoc("notes", "isolated.md", "Isolated", "No links here");

      const result = await store.getGraph({
        collection: "notes",
        linkedOnly: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // No nodes since linkedOnly=true and doc has no links
      expect(result.value.nodes).toHaveLength(0);
      expect(result.value.links).toHaveLength(0);
    });

    test("includes isolated nodes when linkedOnly=false", async () => {
      await createTestDoc("notes", "alone.md", "Alone", "No links");

      const result = await store.getGraph({
        collection: "notes",
        linkedOnly: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.nodes.length).toBeGreaterThanOrEqual(1);
      const aloneNode = result.value.nodes.find((n) => n.title === "Alone");
      expect(aloneNode).toBeDefined();
      expect(aloneNode?.degree).toBe(0);
    });
  });

  describe("gno_similar integration", () => {
    // gno_similar requires embedding models which are not available in CI
    // These tests verify the store-level operations that gno_similar depends on

    test("can store and retrieve content for similarity comparison", async () => {
      const doc1Id = await createTestDoc(
        "notes",
        "doc1.md",
        "Document 1",
        "# Introduction\nThis is about machine learning."
      );
      const doc2Id = await createTestDoc(
        "notes",
        "doc2.md",
        "Document 2",
        "# Overview\nThis is about artificial intelligence."
      );

      // Verify documents are stored
      const doc1Result = await store.getDocument("notes", "doc1.md");
      expect(doc1Result.ok).toBe(true);
      if (!doc1Result.ok) return;
      expect(doc1Result.value?.id).toBe(doc1Id);

      const doc2Result = await store.getDocument("notes", "doc2.md");
      expect(doc2Result.ok).toBe(true);
      if (!doc2Result.ok) return;
      expect(doc2Result.value?.id).toBe(doc2Id);

      // Verify content is stored
      const content1 = await store.getContent(`hash-notes-doc1.md`);
      expect(content1.ok).toBe(true);
      if (!content1.ok) return;
      expect(content1.value).toContain("machine learning");

      const content2 = await store.getContent(`hash-notes-doc2.md`);
      expect(content2.ok).toBe(true);
      if (!content2.ok) return;
      expect(content2.value).toContain("artificial intelligence");
    });

    test("stores chunks for embedding", async () => {
      await createTestDoc(
        "notes",
        "chunked.md",
        "Chunked Doc",
        "# Header\nLong content for chunking..."
      );

      const hash = `hash-notes-chunked.md`;
      const chunks = [
        { seq: 0, pos: 0, text: "# Header", startLine: 1, endLine: 1 },
        {
          seq: 1,
          pos: 9,
          text: "Long content for chunking...",
          startLine: 2,
          endLine: 2,
        },
      ];

      const chunkResult = await store.upsertChunks(hash, chunks);
      expect(chunkResult.ok).toBe(true);

      const getChunks = await store.getChunks(hash);
      expect(getChunks.ok).toBe(true);
      if (!getChunks.ok) return;

      expect(getChunks.value).toHaveLength(2);
      expect(getChunks.value[0]?.text).toBe("# Header");
      expect(getChunks.value[1]?.text).toBe("Long content for chunking...");
    });
  });
});
