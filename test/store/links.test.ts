/**
 * Tests for link storage methods in SQLite adapter.
 *
 * @module test/store/links
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocLinkInput, DocumentInput } from "../../src/store/types";

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
      expect(
        graph.value.links.some((link) => link.target === docBValue.docid)
      ).toBe(false);
    });
  });
});
