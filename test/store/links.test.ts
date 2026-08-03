/**
 * Tests for link storage methods in SQLite adapter.
 *
 * @module test/store/links
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DocEdgeInput,
  DocLinkInput,
  DocumentInput,
} from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("SqliteAdapter links", () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-links-"));
    dbPath = join(tmpDir, "test.db");
    adapter = new SqliteAdapter();
    const result = await adapter.open(dbPath, "porter");
    expect(result.ok).toBe(true);

    // Sync collections so documents can reference them
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
    const syncResult = await adapter.syncCollections(collections);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  /**
   * Helper to create a test document and return its id
   */
  async function createTestDoc(
    collection: string,
    relPath: string,
    title: string,
    hash?: string
  ): Promise<number> {
    const doc: DocumentInput = {
      collection,
      relPath,
      sourceHash: hash ?? `hash-${relPath}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: new Date().toISOString(),
      title,
      mirrorHash: hash ?? `hash-${relPath}`,
      ingestVersion: 3,
    };
    const result = await adapter.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Failed to create test doc");
    return result.value.id;
  }

  describe("setDocLinks", () => {
    test("sets parsed links for document", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

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
      ];

      const result = await adapter.setDocLinks(docId, links, "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(1);
      expect(linksResult.value[0]?.targetRef).toBe("Target Note");
      expect(linksResult.value[0]?.linkType).toBe("wiki");
      expect(linksResult.value[0]?.source).toBe("parsed");
    });

    test("stores markdown links with path", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "./docs/guide.md",
          targetRefNorm: "docs/guide.md",
          targetAnchor: "section",
          linkType: "markdown",
          linkText: "the guide",
          startLine: 5,
          startCol: 10,
          endLine: 5,
          endCol: 35,
        },
      ];

      const result = await adapter.setDocLinks(docId, links, "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(1);
      expect(linksResult.value[0]?.targetRef).toBe("./docs/guide.md");
      expect(linksResult.value[0]?.targetRefNorm).toBe("docs/guide.md");
      expect(linksResult.value[0]?.targetAnchor).toBe("section");
      expect(linksResult.value[0]?.linkText).toBe("the guide");
    });

    test("stores collection prefix", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "FAQ",
          targetRefNorm: "faq",
          targetCollection: "docs",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 15,
        },
      ];

      const result = await adapter.setDocLinks(docId, links, "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value[0]?.targetCollection).toBe("docs");
    });

    test("replaces links from same source", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      // Set initial links
      const initialLinks: DocLinkInput[] = [
        {
          targetRef: "Old Note",
          targetRefNorm: "old note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 15,
        },
      ];
      await adapter.setDocLinks(docId, initialLinks, "parsed");

      // Replace with new links
      const newLinks: DocLinkInput[] = [
        {
          targetRef: "New Note",
          targetRefNorm: "new note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 15,
        },
      ];
      const result = await adapter.setDocLinks(docId, newLinks, "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(1);
      expect(linksResult.value[0]?.targetRef).toBe("New Note");
    });

    test("preserves links from different sources", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      // Set parsed link
      const parsedLinks: DocLinkInput[] = [
        {
          targetRef: "Parsed",
          targetRefNorm: "parsed",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 15,
        },
      ];
      await adapter.setDocLinks(docId, parsedLinks, "parsed");

      // Set user link
      const userLinks: DocLinkInput[] = [
        {
          targetRef: "User Added",
          targetRefNorm: "user added",
          linkType: "wiki",
          startLine: 2,
          startCol: 1,
          endLine: 2,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(docId, userLinks, "user");

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(2);
      const targets = linksResult.value.map((l) => l.targetRef);
      expect(targets).toContain("Parsed");
      expect(targets).toContain("User Added");
    });

    test("handles empty links array", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      // Set then clear links
      const links: DocLinkInput[] = [
        {
          targetRef: "Note",
          targetRefNorm: "note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 10,
        },
      ];
      await adapter.setDocLinks(docId, links, "parsed");
      const result = await adapter.setDocLinks(docId, [], "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(0);
    });

    test("stores multiple links with different positions", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "First",
          targetRefNorm: "first",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 12,
        },
        {
          targetRef: "Second",
          targetRefNorm: "second",
          linkType: "wiki",
          startLine: 1,
          startCol: 20,
          endLine: 1,
          endCol: 32,
        },
        {
          targetRef: "Third",
          targetRefNorm: "third",
          linkType: "wiki",
          startLine: 3,
          startCol: 5,
          endLine: 3,
          endCol: 16,
        },
      ];

      const result = await adapter.setDocLinks(docId, links, "parsed");
      expect(result.ok).toBe(true);

      const linksResult = await adapter.getLinksForDoc(docId);
      expect(linksResult.ok).toBe(true);
      if (!linksResult.ok) return;

      expect(linksResult.value).toHaveLength(3);
      // Should be sorted by line, then column
      expect(linksResult.value[0]?.targetRef).toBe("First");
      expect(linksResult.value[1]?.targetRef).toBe("Second");
      expect(linksResult.value[2]?.targetRef).toBe("Third");
    });
  });

  describe("doc_edges", () => {
    test("sets edges replace-by-source and reads active targets only", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      const targetAId = await createTestDoc("notes", "target-a.md", "Target A");
      const targetBId = await createTestDoc("notes", "target-b.md", "Target B");

      const edges: DocEdgeInput[] = [
        { targetDocId: targetAId, edgeType: "works_at", confidence: "parsed" },
        { targetDocId: targetBId, edgeType: "works_at", confidence: "parsed" },
      ];
      const setResult = await adapter.setDocEdges(sourceId, edges, "wikilink");
      expect(setResult.ok).toBe(true);

      const firstRead = await adapter.getEdgesForDoc(sourceId, {
        edgeType: "works_at",
      });
      expect(firstRead.ok).toBe(true);
      if (!firstRead.ok) return;
      expect(firstRead.value.map((edge) => edge.targetTitle)).toEqual([
        "Target A",
        "Target B",
      ]);

      const replaceResult = await adapter.setDocEdges(
        sourceId,
        [
          {
            targetDocId: targetBId,
            edgeType: "works_at",
            confidence: "parsed",
          },
        ],
        "wikilink"
      );
      expect(replaceResult.ok).toBe(true);

      const replacedRead = await adapter.getEdgesForDoc(sourceId, {
        edgeType: "works_at",
      });
      expect(replacedRead.ok).toBe(true);
      if (!replacedRead.ok) return;
      expect(replacedRead.value).toHaveLength(1);
      expect(replacedRead.value[0]?.targetTitle).toBe("Target B");

      const inactiveResult = await adapter.markInactive("notes", [
        "target-b.md",
      ]);
      expect(inactiveResult.ok).toBe(true);

      const activeRead = await adapter.getEdgesForDoc(sourceId, {
        edgeType: "works_at",
      });
      expect(activeRead.ok).toBe(true);
      if (!activeRead.ok) return;
      expect(activeRead.value).toHaveLength(0);
    });

    test("dedups by edge type with confidence precedence", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      const targetId = await createTestDoc("notes", "target.md", "Target");

      await adapter.setDocEdges(
        sourceId,
        [{ targetDocId: targetId, edgeType: "mentions", confidence: "parsed" }],
        "wikilink"
      );
      await adapter.setDocEdges(
        sourceId,
        [{ targetDocId: targetId, edgeType: "mentions", confidence: "manual" }],
        "frontmatter-relation"
      );

      const edges = await adapter.getEdgesForDoc(sourceId, {
        edgeType: "mentions",
      });
      expect(edges.ok).toBe(true);
      if (!edges.ok) return;
      expect(edges.value).toHaveLength(1);
      expect(edges.value[0]?.confidence).toBe("manual");
      expect(edges.value[0]?.edgeSource).toBe("frontmatter-relation");
    });

    test("backfills resolved doc_links with getGraph parity", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      const targetId = await createTestDoc(
        "notes",
        "folder/target.md",
        "Target"
      );

      await adapter.setDocLinks(
        sourceId,
        [
          {
            targetRef: "Target",
            targetRefNorm: "target",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 11,
          },
        ],
        "parsed"
      );

      const backfill = await adapter.backfillDocEdges();
      expect(backfill.ok).toBe(true);
      if (!backfill.ok) return;
      expect(backfill.value.inserted).toBe(1);

      const edgeResult = await adapter.getEdgesForDoc(sourceId);
      expect(edgeResult.ok).toBe(true);
      if (!edgeResult.ok) return;
      expect(edgeResult.value).toHaveLength(1);
      expect(edgeResult.value[0]?.targetDocId).toBe(targetId);
      expect(edgeResult.value[0]?.edgeType).toBe("mentions");
      expect(edgeResult.value[0]?.edgeSource).toBe("wikilink");

      const graph = await adapter.getGraph({ collection: "notes" });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;
      expect(graph.value.links).toContainEqual(
        expect.objectContaining({
          source: edgeResult.value[0]?.sourceDocid,
          target: edgeResult.value[0]?.targetDocid,
          type: "wiki",
        })
      );

      const secondBackfill = await adapter.backfillDocEdges();
      expect(secondBackfill.ok).toBe(true);
      if (!secondBackfill.ok) return;
      expect(secondBackfill.value.inserted).toBe(1);
    });
  });

  describe("getLinksForDoc", () => {
    test("returns empty array for document with no links", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      const result = await adapter.getLinksForDoc(docId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual([]);
    });

    test("returns links sorted by position", async () => {
      const docId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "Last",
          targetRefNorm: "last",
          linkType: "wiki",
          startLine: 10,
          startCol: 1,
          endLine: 10,
          endCol: 10,
        },
        {
          targetRef: "First",
          targetRefNorm: "first",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 10,
        },
      ];
      await adapter.setDocLinks(docId, links, "parsed");

      const result = await adapter.getLinksForDoc(docId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.targetRef).toBe("First");
      expect(result.value[1]?.targetRef).toBe("Last");
    });
  });

  describe("resolveLinks", () => {
    test("resolves wiki paths by title basename", async () => {
      await createTestDoc("notes", "target.md", "Target Note");

      const docResult = await adapter.getDocument("notes", "target.md");
      expect(docResult.ok).toBe(true);
      if (!docResult.ok || !docResult.value) return;

      const result = await adapter.resolveLinks([
        {
          targetRefNorm: "vault/target note.md",
          targetCollection: "notes",
          linkType: "wiki",
        },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.docid).toBe(docResult.value.docid);
    });

    test("resolves wiki paths by rel_path basename", async () => {
      await createTestDoc("notes", "task.md", "Different Title");

      const docResult = await adapter.getDocument("notes", "task.md");
      expect(docResult.ok).toBe(true);
      if (!docResult.ok || !docResult.value) return;

      const result = await adapter.resolveLinks([
        {
          targetRefNorm: "vault/task.md",
          targetCollection: "notes",
          linkType: "wiki",
        },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.docid).toBe(docResult.value.docid);
    });

    test("resolves wiki refs without extension to .md rel_path", async () => {
      await createTestDoc("notes", "task.md", "Different Title");

      const docResult = await adapter.getDocument("notes", "task.md");
      expect(docResult.ok).toBe(true);
      if (!docResult.ok || !docResult.value) return;

      const result = await adapter.resolveLinks([
        {
          targetRefNorm: "task",
          targetCollection: "notes",
          linkType: "wiki",
        },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.docid).toBe(docResult.value.docid);
    });

    test("resolves wiki refs to subfolder rel_path by basename", async () => {
      await createTestDoc("notes", "projects/task.md", "Different Title");

      const docResult = await adapter.getDocument("notes", "projects/task.md");
      expect(docResult.ok).toBe(true);
      if (!docResult.ok || !docResult.value) return;

      const result = await adapter.resolveLinks([
        {
          targetRefNorm: "task.md",
          targetCollection: "notes",
          linkType: "wiki",
        },
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.docid).toBe(docResult.value.docid);
    });

    test("resolves large batches without reordering", async () => {
      await createTestDoc("notes", "bulk.md", "Bulk");

      const docResult = await adapter.getDocument("notes", "bulk.md");
      expect(docResult.ok).toBe(true);
      if (!docResult.ok || !docResult.value) return;

      const targets = Array.from({ length: 900 }, (_, idx) => ({
        targetRefNorm: idx % 2 === 0 ? "bulk" : "bulk.md",
        targetCollection: "notes",
        linkType: (idx % 2 === 0 ? "wiki" : "markdown") as "wiki" | "markdown",
      }));

      const result = await adapter.resolveLinks(targets);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(targets.length);
      for (const resolved of result.value) {
        expect(resolved?.docid).toBe(docResult.value.docid);
      }
    });
  });

  describe("getBacklinksForDoc", () => {
    test("finds wiki backlinks by normalized title", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sourceId = await createTestDoc("notes", "source.md", "Source Note");

      // Create link from source to target (by wiki name)
      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note", // normalized
          linkType: "wiki",
          linkText: "see target",
          startLine: 5,
          startCol: 10,
          endLine: 5,
          endCol: 30,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sourceId);
      expect(result.value[0]?.linkText).toBe("see target");
      expect(result.value[0]?.startLine).toBe(5);
    });

    test("finds markdown backlinks by rel_path", async () => {
      const targetId = await createTestDoc("notes", "docs/guide.md", "Guide");
      const sourceId = await createTestDoc("notes", "index.md", "Index");

      // Create markdown link from source to target (by path)
      const links: DocLinkInput[] = [
        {
          targetRef: "./docs/guide.md",
          targetRefNorm: "docs/guide.md", // normalized path
          linkType: "markdown",
          startLine: 3,
          startCol: 1,
          endLine: 3,
          endCol: 25,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sourceId);
    });

    test("returns empty for document with no backlinks", async () => {
      const targetId = await createTestDoc("notes", "lonely.md", "Lonely Note");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual([]);
    });

    test("excludes backlinks from inactive documents", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const activeSourceId = await createTestDoc(
        "notes",
        "active.md",
        "Active"
      );
      const inactiveSourceId = await createTestDoc(
        "notes",
        "inactive.md",
        "Inactive"
      );

      // Create links from both sources
      const activeLinks: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(activeSourceId, activeLinks, "parsed");
      await adapter.setDocLinks(inactiveSourceId, activeLinks, "parsed");

      // Mark one source as inactive
      await adapter.markInactive("notes", ["inactive.md"]);

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(activeSourceId);
    });

    test("filters by collection prefix", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sameCollSourceId = await createTestDoc(
        "notes",
        "same.md",
        "Same Coll"
      );
      const diffCollSourceId = await createTestDoc(
        "docs",
        "diff.md",
        "Diff Coll"
      );

      // Link from same collection (no target_collection)
      const sameCollLinks: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(sameCollSourceId, sameCollLinks, "parsed");

      // Link from different collection with explicit target_collection
      const diffCollLinks: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          targetCollection: "notes",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(diffCollSourceId, diffCollLinks, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both should be found - same collection link and cross-collection link
      expect(result.value).toHaveLength(2);
    });

    test("filters backlinks by source collection", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sameCollSourceId = await createTestDoc(
        "notes",
        "same.md",
        "Same Coll"
      );
      const diffCollSourceId = await createTestDoc(
        "docs",
        "diff.md",
        "Diff Coll"
      );

      const sameCollLinks: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(sameCollSourceId, sameCollLinks, "parsed");

      const diffCollLinks: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          targetCollection: "notes",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(diffCollSourceId, diffCollLinks, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId, {
        collection: "notes",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sameCollSourceId);
    });

    test("handles multiple backlinks from same document", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sourceId = await createTestDoc("notes", "source.md", "Source");

      // Multiple links to same target
      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 5,
          startCol: 1,
          endLine: 5,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(2);
    });

    test("finds wiki backlinks by path-style title", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sourceId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "vault/Target Note.md",
          targetRefNorm: "vault/target note.md",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 24,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sourceId);
    });

    test("finds wiki backlinks by path-style rel_path", async () => {
      const targetId = await createTestDoc("notes", "note.md", "Different");
      const sourceId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "vault/note.md",
          targetRefNorm: "vault/note.md",
          linkType: "wiki",
          startLine: 2,
          startCol: 1,
          endLine: 2,
          endCol: 16,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const result = await adapter.getBacklinksForDoc(targetId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.sourceDocId).toBe(sourceId);
    });
  });

  describe("document deletion cascades", () => {
    test("deleting source document removes its links", async () => {
      const targetId = await createTestDoc("notes", "target.md", "Target Note");
      const sourceId = await createTestDoc("notes", "source.md", "Source");

      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 20,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      // Verify link exists
      let backlinks = await adapter.getBacklinksForDoc(targetId);
      expect(backlinks.ok && backlinks.value.length).toBe(1);

      // Mark source as inactive (simulating deletion)
      await adapter.markInactive("notes", ["source.md"]);

      // Backlinks should no longer include the inactive source
      backlinks = await adapter.getBacklinksForDoc(targetId);
      expect(backlinks.ok).toBe(true);
      if (!backlinks.ok) return;
      expect(backlinks.value).toHaveLength(0);
    });
  });

  describe("getGraph", () => {
    test("reports hubs, bridge candidates, isolates, unresolved links, and edge breakdown", async () => {
      const hubId = await createTestDoc("notes", "hub.md", "Hub");
      const spokeAId = await createTestDoc("notes", "spoke-a.md", "Spoke A");
      const spokeBId = await createTestDoc("notes", "spoke-b.md", "Spoke B");
      await createTestDoc("notes", "isolated.md", "Isolated");

      const hubDoc = await adapter.getDocument("notes", "hub.md");
      expect(hubDoc.ok).toBe(true);
      if (!hubDoc.ok || !hubDoc.value) return;

      await adapter.setDocLinks(
        hubId,
        [
          {
            targetRef: "Spoke A",
            targetRefNorm: "spoke a",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 12,
          },
          {
            targetRef: "spoke-b.md",
            targetRefNorm: "spoke-b.md",
            linkType: "markdown",
            startLine: 2,
            startCol: 1,
            endLine: 2,
            endCol: 20,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        spokeAId,
        [
          {
            targetRef: "hub.md",
            targetRefNorm: "hub.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 15,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        spokeBId,
        [
          {
            targetRef: "missing",
            targetRefNorm: "missing",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 11,
          },
        ],
        "parsed"
      );

      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: false,
        limitNodes: 10,
        limitEdges: 1,
        includeSimilar: true,
      });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;

      expect(graph.value.report.hubs[0]?.id).toBe(hubDoc.value.docid);
      expect(graph.value.report.hubs[0]?.degree).toBe(3);
      expect(
        graph.value.report.bridgeCandidates.some(
          (node) => node.id === hubDoc.value?.docid
        )
      ).toBe(true);
      expect(graph.value.report.isolated.total).toBe(1);
      expect(graph.value.report.isolated.examples[0]?.title).toBe("Isolated");
      expect(graph.value.report.unresolvedLinks).toEqual({
        total: 1,
        byType: { wiki: 1, markdown: 0 },
      });
      expect(graph.value.report.edgeTypes).toEqual({
        wiki: 1,
        markdown: 2,
        similar: 0,
      });
      expect(graph.value.report.edgeConfidence).toEqual({
        explicit: 3,
        inferred: 0,
        ambiguous: 0,
        similarity: 0,
      });
      expect(graph.value.report.audit).toEqual({
        inferredEdges: 0,
        ambiguousEdges: 0,
        similarityEdges: 0,
      });
      expect(graph.value.report.communities.total).toBeGreaterThanOrEqual(2);
      expect(graph.value.report.communities.skipped).toBe(false);
      expect(graph.value.nodes.every((node) => node.communityId)).toBe(true);
      expect(graph.value.links).toHaveLength(1);
      expect(graph.value.meta.truncated).toBe(true);
      expect(graph.value.meta.warnings).toContain("Edges truncated: 3 → 1");
      expect(graph.value.meta.warnings).toContain(
        "Similarity edges unavailable: sqlite-vec not loaded"
      );
    });

    test("resolves wiki links to subfolder rel_path by basename", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      await createTestDoc("notes", "projects/task.md", "Different Title");

      const sourceDoc = await adapter.getDocument("notes", "source.md");
      const targetDoc = await adapter.getDocument("notes", "projects/task.md");
      expect(sourceDoc.ok).toBe(true);
      expect(targetDoc.ok).toBe(true);
      if (
        !sourceDoc.ok ||
        !targetDoc.ok ||
        !sourceDoc.value ||
        !targetDoc.value
      )
        return;
      const sourceValue = sourceDoc.value;
      const targetValue = targetDoc.value;

      const links: DocLinkInput[] = [
        {
          targetRef: "task.md",
          targetRefNorm: "task.md",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 12,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: false,
        limitNodes: 100,
        limitEdges: 100,
      });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;

      const edge = graph.value.links.find(
        (link) =>
          link.source === sourceValue.docid && link.target === targetValue.docid
      );
      expect(edge).toBeDefined();
      expect(edge?.confidence).toBe("inferred");
      expect(edge?.audit).toEqual({
        resolution: "path-fallback",
        matchCount: 1,
      });
    });

    test("resolves ambiguous basename deterministically by id", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      await createTestDoc("notes", "projects/task.md", "Project Task");
      await createTestDoc("notes", "work/task.md", "Work Task");

      const docA = await adapter.getDocument("notes", "projects/task.md");
      const docB = await adapter.getDocument("notes", "work/task.md");
      expect(docA.ok).toBe(true);
      expect(docB.ok).toBe(true);
      if (!docA.ok || !docB.ok || !docA.value || !docB.value) return;
      const docAValue = docA.value;
      const docBValue = docB.value;

      const links: DocLinkInput[] = [
        {
          targetRef: "task.md",
          targetRefNorm: "task.md",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 12,
        },
      ];
      await adapter.setDocLinks(sourceId, links, "parsed");

      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: false,
        limitNodes: 100,
        limitEdges: 100,
      });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;

      const edge = graph.value.links.find(
        (link) => link.target === docAValue.docid
      );
      expect(edge).toBeDefined();
      expect(edge?.confidence).toBe("ambiguous");
      expect(edge?.audit).toEqual({
        resolution: "ambiguous-fallback",
        matchCount: 2,
      });
      expect(graph.value.report.edgeConfidence.ambiguous).toBe(1);
      expect(graph.value.report.audit.ambiguousEdges).toBe(1);
      expect(
        graph.value.links.some((link) => link.target === docBValue.docid)
      ).toBe(false);
    });

    test("merged graph edges keep best available confidence", async () => {
      const sourceId = await createTestDoc("notes", "source.md", "Source");
      await createTestDoc("notes", "projects/task.md", "Target Task");
      await createTestDoc("notes", "archive/task.md", "Archive Task");

      const target = await adapter.getDocument("notes", "projects/task.md");
      expect(target.ok).toBe(true);
      if (!target.ok || !target.value) return;
      const targetValue = target.value;

      await adapter.setDocLinks(
        sourceId,
        [
          {
            targetRef: "task.md",
            targetRefNorm: "task.md",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 12,
          },
          {
            targetRef: "projects/task.md",
            targetRefNorm: "projects/task.md",
            linkType: "wiki",
            startLine: 2,
            startCol: 1,
            endLine: 2,
            endCol: 19,
          },
        ],
        "parsed"
      );

      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: false,
        limitNodes: 100,
        limitEdges: 100,
      });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;

      const edge = graph.value.links.find(
        (link) => link.target === targetValue.docid
      );
      expect(edge).toBeDefined();
      expect(edge?.weight).toBe(2);
      expect(edge?.confidence).toBe("explicit");
      expect(edge?.audit.matchCount).toBe(2);
    });

    test("detects stable communities across deterministic graph runs", async () => {
      const a1 = await createTestDoc("notes", "a1.md", "Alpha 1");
      const a2 = await createTestDoc("notes", "a2.md", "Alpha 2");
      const b1 = await createTestDoc("notes", "b1.md", "Beta 1");
      const b2 = await createTestDoc("notes", "b2.md", "Beta 2");

      await adapter.setDocLinks(
        a1,
        [
          {
            targetRef: "a2.md",
            targetRefNorm: "a2.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 8,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        a2,
        [
          {
            targetRef: "a1.md",
            targetRefNorm: "a1.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 8,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        b1,
        [
          {
            targetRef: "b2.md",
            targetRefNorm: "b2.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 8,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        b2,
        [
          {
            targetRef: "b1.md",
            targetRefNorm: "b1.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 8,
          },
        ],
        "parsed"
      );

      const first = await adapter.getGraph({
        collection: "notes",
        limitNodes: 10,
        limitEdges: 10,
      });
      const second = await adapter.getGraph({
        collection: "notes",
        limitNodes: 10,
        limitEdges: 10,
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(first.value.report.communities.total).toBe(2);
      expect(first.value.report.communities.assignments).toEqual(
        second.value.report.communities.assignments
      );
      expect(first.value.report.communities.top.map((c) => c.id)).toEqual([
        "c1",
        "c2",
      ]);
    });

    test("skips community detection for large returned graphs", async () => {
      for (let i = 0; i < 2001; i++) {
        await createTestDoc("notes", `large-${i}.md`, `Large ${i}`);
      }

      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: false,
        limitNodes: 2001,
        limitEdges: 10,
      });
      expect(graph.ok).toBe(true);
      if (!graph.ok) return;

      expect(graph.value.report.communities.skipped).toBe(true);
      expect(graph.value.report.communities.top).toEqual([]);
      expect(graph.value.meta.warnings).toContain(
        "Community detection skipped: graph has 2001 nodes (cap 2000)"
      );
    });
  });

  describe("getGraphNeighborsForSeeds", () => {
    test("returns one-hop outgoing and backlink neighbors with confidence", async () => {
      const seedId = await createTestDoc("notes", "seed.md", "Seed");
      const outId = await createTestDoc("notes", "outgoing.md", "Outgoing");
      const backId = await createTestDoc("notes", "backlink.md", "Backlink");
      await createTestDoc("notes", "unrelated.md", "Unrelated");

      await adapter.setDocLinks(
        seedId,
        [
          {
            targetRef: "Outgoing",
            targetRefNorm: "outgoing",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 12,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        backId,
        [
          {
            targetRef: "seed.md",
            targetRefNorm: "seed.md",
            linkType: "markdown",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 15,
          },
        ],
        "parsed"
      );
      await adapter.setDocLinks(
        outId,
        [
          {
            targetRef: "Unrelated",
            targetRefNorm: "unrelated",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 12,
          },
        ],
        "parsed"
      );

      const seedDoc = await adapter.getDocument("notes", "seed.md");
      const outDoc = await adapter.getDocument("notes", "outgoing.md");
      const backDoc = await adapter.getDocument("notes", "backlink.md");
      expect(seedDoc.ok && seedDoc.value).toBeTruthy();
      expect(outDoc.ok && outDoc.value).toBeTruthy();
      expect(backDoc.ok && backDoc.value).toBeTruthy();
      if (!seedDoc.ok || !seedDoc.value || !outDoc.ok || !outDoc.value) return;
      if (!backDoc.ok || !backDoc.value) return;

      const neighbors = await adapter.getGraphNeighborsForSeeds({
        seedDocumentIds: [seedId],
        collection: "notes",
      });
      expect(neighbors.ok).toBe(true);
      if (!neighbors.ok) return;

      expect(neighbors.value.links).toHaveLength(2);
      expect(
        neighbors.value.links.some(
          (link) =>
            link.source === seedDoc.value?.docid &&
            link.target === outDoc.value?.docid &&
            link.confidence === "explicit"
        )
      ).toBe(true);
      expect(
        neighbors.value.links.some(
          (link) =>
            link.source === backDoc.value?.docid &&
            link.target === seedDoc.value?.docid &&
            link.confidence === "explicit"
        )
      ).toBe(true);
      expect(neighbors.value.meta.seedDocumentIds).toEqual([seedId]);
    });

    test("scans wiki candidates once for all seeds and reports actual work", async () => {
      const firstSeedId = await createTestDoc(
        "notes",
        "first-seed.md",
        "First Seed"
      );
      const secondSeedId = await createTestDoc(
        "notes",
        "second-seed.md",
        "Second Seed"
      );
      const backlinkId = await createTestDoc(
        "notes",
        "backlink.md",
        "Backlink"
      );

      await adapter.setDocLinks(
        backlinkId,
        [
          {
            targetRef: "vault/First Seed.md",
            targetRefNorm: "vault/first seed.md",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 24,
          },
        ],
        "parsed"
      );

      for (let i = 0; i < 200; i++) {
        const leftId = await createTestDoc(
          "notes",
          `noise-left-${i}.md`,
          `Noise Left ${i}`
        );
        await createTestDoc("notes", `noise-right-${i}.md`, `Noise Right ${i}`);
        await adapter.setDocLinks(
          leftId,
          [
            {
              targetRef: `Noise Right ${i}`,
              targetRefNorm: `noise right ${i}`,
              linkType: "wiki",
              startLine: 1,
              startCol: 1,
              endLine: 1,
              endCol: 20,
            },
          ],
          "parsed"
        );
      }

      const oneSeed = await adapter.getGraphNeighborsForSeeds({
        seedDocumentIds: [firstSeedId],
        collection: "notes",
      });
      const twoSeeds = await adapter.getGraphNeighborsForSeeds({
        seedDocumentIds: [firstSeedId, secondSeedId],
        collection: "notes",
      });
      expect(oneSeed.ok).toBe(true);
      expect(twoSeeds.ok).toBe(true);
      if (!oneSeed.ok || !twoSeeds.ok) return;

      expect(oneSeed.value.links).toHaveLength(1);
      expect(twoSeeds.value.links).toHaveLength(1);
      expect(oneSeed.value.meta.examinedLinkRows).toBe(201);
      expect(twoSeeds.value.meta.examinedLinkRows).toBe(201);
    });

    test("matches getGraph confidence for the same seed-adjacent edges", async () => {
      const seedId = await createTestDoc("notes", "seed.md", "Seed");
      await createTestDoc("notes", "exact.md", "Exact Title");
      await createTestDoc("notes", "path-only.md", "Different Title");
      await createTestDoc("notes", "nested/fallback.md", "Fallback Target");
      await createTestDoc("notes", "duplicate-a.md", "Duplicate");
      await createTestDoc("notes", "duplicate-b.md", "Duplicate");

      await adapter.setDocLinks(
        seedId,
        [
          {
            targetRef: "Exact Title",
            targetRefNorm: "exact title",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 14,
          },
          {
            targetRef: "path-only.md",
            targetRefNorm: "path-only.md",
            linkType: "markdown",
            startLine: 2,
            startCol: 1,
            endLine: 2,
            endCol: 20,
          },
          {
            targetRef: "fallback",
            targetRefNorm: "fallback",
            linkType: "wiki",
            startLine: 3,
            startCol: 1,
            endLine: 3,
            endCol: 12,
          },
          {
            targetRef: "Duplicate",
            targetRefNorm: "duplicate",
            linkType: "wiki",
            startLine: 4,
            startCol: 1,
            endLine: 4,
            endCol: 13,
          },
        ],
        "parsed"
      );

      const neighbors = await adapter.getGraphNeighborsForSeeds({
        seedDocumentIds: [seedId],
        collection: "notes",
      });
      const graph = await adapter.getGraph({
        collection: "notes",
        linkedOnly: true,
      });
      expect(neighbors.ok).toBe(true);
      expect(graph.ok).toBe(true);
      if (!neighbors.ok || !graph.ok) return;

      const neighborKeys = new Map(
        neighbors.value.links.map((link) => [
          `${link.source}:${link.target}:${link.type}`,
          link,
        ])
      );
      for (const link of graph.value.links) {
        const key = `${link.source}:${link.target}:${link.type}`;
        const scoped = neighborKeys.get(key);
        expect(scoped).toBeDefined();
        expect(scoped?.confidence).toBe(link.confidence);
        expect(scoped?.audit.resolution).toBe(link.audit.resolution);
      }
      expect(
        new Set(neighbors.value.links.map((link) => link.confidence))
      ).toEqual(new Set(["explicit", "inferred", "ambiguous"]));
    });
  });

  describe("getFileRefactorResolutionSnapshot", () => {
    test("returns bounded catalog and referrer content without mutation", async () => {
      const sourceId = await createTestDoc("notes", "old-note.md", "Old Note");
      const referrerId = await createTestDoc(
        "notes",
        "referrer.md",
        "Referrer"
      );
      await createTestDoc("notes", "other.md", "Other");

      const sourceDoc = await adapter.getDocument("notes", "old-note.md");
      const referrerDoc = await adapter.getDocument("notes", "referrer.md");
      const otherDoc = await adapter.getDocument("notes", "other.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      expect(referrerDoc.ok && referrerDoc.value).toBeTruthy();
      expect(otherDoc.ok && otherDoc.value).toBeTruthy();
      if (
        !sourceDoc.ok ||
        !sourceDoc.value ||
        !referrerDoc.ok ||
        !referrerDoc.value ||
        !otherDoc.ok ||
        !otherDoc.value
      ) {
        return;
      }

      await adapter.upsertContent(
        sourceDoc.value.mirrorHash!,
        "# Old Note\nbody"
      );
      await adapter.upsertContent(
        referrerDoc.value.mirrorHash!,
        "See [[Old Note]] please."
      );
      await adapter.upsertContent(otherDoc.value.mirrorHash!, "# Other\n");

      await adapter.setDocLinks(
        referrerId,
        [
          {
            targetRef: "Old Note",
            targetRefNorm: "old note",
            linkType: "wiki",
            startLine: 1,
            startCol: 5,
            endLine: 1,
            endCol: 16,
          },
        ],
        "parsed"
      );

      const beforeLinks = await adapter.getLinksForDoc(referrerId);
      expect(beforeLinks.ok).toBe(true);
      if (!beforeLinks.ok) return;

      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;

      expect(snapshot.value.source.relPath).toBe("old-note.md");
      expect(snapshot.value.source.content).toContain("Old Note");
      expect(snapshot.value.source.editable).toBe(true);
      expect(snapshot.value.catalog.length).toBeGreaterThanOrEqual(3);
      expect(snapshot.value.occupiedRelPaths).toContain("old-note.md");
      expect(snapshot.value.referrers).toHaveLength(1);
      expect(snapshot.value.referrers[0]?.relPath).toBe("referrer.md");
      expect(snapshot.value.referrers[0]?.content).toContain("[[Old Note]]");
      expect(snapshot.value.referrers[0]?.editable).toBe(true);
      expect(snapshot.value.truncated).toBe(false);

      const afterLinks = await adapter.getLinksForDoc(referrerId);
      expect(afterLinks.ok).toBe(true);
      if (!afterLinks.ok) return;
      expect(afterLinks.value).toEqual(beforeLinks.value);

      const missing = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: "gno://notes/missing.md",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error.code).toBe("NOT_FOUND");
      }

      expect(sourceId).toBeGreaterThan(0);
    });

    test("surfaces opaque-only embed and raw HTML not present in doc_links", async () => {
      await createTestDoc("notes", "old-note.md", "Old Note");
      await createTestDoc("notes", "embedder.md", "Embedder");
      await createTestDoc("notes", "html-ref.md", "Html Ref");

      const sourceDoc = await adapter.getDocument("notes", "old-note.md");
      const embedderDoc = await adapter.getDocument("notes", "embedder.md");
      const htmlDoc = await adapter.getDocument("notes", "html-ref.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      expect(embedderDoc.ok && embedderDoc.value).toBeTruthy();
      expect(htmlDoc.ok && htmlDoc.value).toBeTruthy();
      if (
        !sourceDoc.ok ||
        !sourceDoc.value ||
        !embedderDoc.ok ||
        !embedderDoc.value ||
        !htmlDoc.ok ||
        !htmlDoc.value
      ) {
        return;
      }

      await adapter.upsertContent(sourceDoc.value.mirrorHash!, "# Old Note\n");
      await adapter.upsertContent(
        embedderDoc.value.mirrorHash!,
        "Opaque only ![[Old Note]] here."
      );
      await adapter.upsertContent(
        htmlDoc.value.mirrorHash!,
        '<p><a href="old-note.md">Old</a></p>'
      );

      // Intentionally no setDocLinks — opaque forms are absent from doc_links.
      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;

      const paths = snapshot.value.referrers.map((row) => row.relPath).sort();
      expect(paths).toContain("embedder.md");
      expect(paths).toContain("html-ref.md");
      expect(
        snapshot.value.referrers.some((row) =>
          row.content?.includes("![[Old Note]]")
        )
      ).toBe(true);
      expect(
        snapshot.value.referrers.some((row) =>
          row.content?.includes('href="old-note.md"')
        )
      ).toBe(true);
    });

    test("projects editable=false for logical-record documents", async () => {
      const record: DocumentInput = {
        collection: "notes",
        relPath: "export/record.md",
        sourceHash: "hash-record",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        title: "Record",
        mirrorHash: "hash-record",
        ingestVersion: 3,
        recordKey: "rec-1",
      };
      const upsert = await adapter.upsertDocument(record);
      expect(upsert.ok).toBe(true);
      if (!upsert.ok) return;

      await createTestDoc("notes", "old-note.md", "Old Note");
      const sourceDoc = await adapter.getDocument("notes", "old-note.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      if (!sourceDoc.ok || !sourceDoc.value) return;

      await adapter.upsertContent(sourceDoc.value.mirrorHash!, "# Old Note\n");
      await adapter.upsertContent(
        "hash-record",
        "See [[Old Note]] from record."
      );

      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;
      const referrer = snapshot.value.referrers.find(
        (row) => row.relPath === "export/record.md"
      );
      expect(referrer).toBeDefined();
      expect(referrer?.editable).toBe(false);
      expect(referrer?.editableReason).toBe("read_only_document");
    });

    test("surfaces contentMissing for .md with no mirror content and no doc_links", async () => {
      await createTestDoc("notes", "old-note.md", "Old Note");
      const orphan: DocumentInput = {
        collection: "notes",
        relPath: "orphan.md",
        sourceHash: "hash-orphan",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 40,
        sourceMtime: new Date().toISOString(),
        title: "Orphan",
        mirrorHash: "hash-orphan-missing",
        ingestVersion: 3,
      };
      const upsert = await adapter.upsertDocument(orphan);
      expect(upsert.ok).toBe(true);
      if (!upsert.ok) return;

      const sourceDoc = await adapter.getDocument("notes", "old-note.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      if (!sourceDoc.ok || !sourceDoc.value) return;
      await adapter.upsertContent(sourceDoc.value.mirrorHash!, "# Old Note\n");
      // Intentionally no upsertContent for orphan, and no setDocLinks.

      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
        maxReferrerDocuments: 50,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;

      const missing = snapshot.value.referrers.find(
        (row) => row.relPath === "orphan.md"
      );
      expect(missing).toBeDefined();
      expect(missing?.contentMissing).toBe(true);
      expect(missing?.content).toBeNull();
      expect(snapshot.value.truncated).toBe(true);
      expect(snapshot.value.truncationReasons).toContain(
        "referrer_content_missing"
      );
    });

    test("marks truncated source_content_missing for editable .md with null mirror hash", async () => {
      const source: DocumentInput = {
        collection: "notes",
        relPath: "no-mirror.md",
        sourceHash: "hash-no-mirror",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 40,
        sourceMtime: new Date().toISOString(),
        title: "No Mirror",
        // Intentionally omit mirrorHash so store writes NULL.
        ingestVersion: 3,
      };
      const upsert = await adapter.upsertDocument(source);
      expect(upsert.ok).toBe(true);
      if (!upsert.ok) return;

      const sourceDoc = await adapter.getDocument("notes", "no-mirror.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      if (!sourceDoc.ok || !sourceDoc.value) return;
      expect(sourceDoc.value.mirrorHash).toBeNull();

      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;

      expect(snapshot.value.source.content).toBeNull();
      expect(snapshot.value.source.editable).toBe(true);
      expect(snapshot.value.truncated).toBe(true);
      expect(snapshot.value.truncationReasons).toContain(
        "source_content_missing"
      );
    });

    test("omits non-text missing-mirror binaries from completeness union", async () => {
      await createTestDoc("notes", "old-note.md", "Old Note");
      const pdf: DocumentInput = {
        collection: "notes",
        relPath: "scan.pdf",
        sourceHash: "hash-pdf",
        sourceMime: "application/pdf",
        sourceExt: ".pdf",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        title: "Scan",
        mirrorHash: "hash-pdf-missing",
        ingestVersion: 3,
      };
      const upsert = await adapter.upsertDocument(pdf);
      expect(upsert.ok).toBe(true);
      if (!upsert.ok) return;

      const sourceDoc = await adapter.getDocument("notes", "old-note.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      if (!sourceDoc.ok || !sourceDoc.value) return;
      await adapter.upsertContent(sourceDoc.value.mirrorHash!, "# Old Note\n");

      const snapshot = await adapter.getFileRefactorResolutionSnapshot({
        sourceUri: sourceDoc.value.uri,
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;
      // Safest bounded behavior for non-text: omit — cannot hold md/wiki/HTML refs.
      expect(
        snapshot.value.referrers.some((row) => row.relPath === "scan.pdf")
      ).toBe(false);
      expect(snapshot.value.truncated).toBe(false);
    });
  });
});
