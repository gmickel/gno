/**
 * Tests for tag storage methods in SQLite adapter.
 *
 * @module test/store/tags
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";

describe("SqliteAdapter tags", () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-tags-"));
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a test document and return its id
   */
  async function createTestDoc(
    collection: string,
    relPath: string,
    hash = "abc123",
    mirrorHash?: string
  ): Promise<number> {
    const doc: DocumentInput = {
      collection,
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: new Date().toISOString(),
      title: relPath,
      mirrorHash: mirrorHash ?? hash, // Use source hash as mirror hash by default
      ingestVersion: 2,
    };
    const result = await adapter.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Failed to create test doc");
    return result.value.id;
  }

  describe("setDocTags", () => {
    test("sets frontmatter tags for document", async () => {
      const docId = await createTestDoc("notes", "test.md");

      const result = await adapter.setDocTags(
        docId,
        ["work", "project"],
        "frontmatter"
      );
      expect(result.ok).toBe(true);

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      expect(tagsResult.value).toHaveLength(2);
      expect(tagsResult.value.map((t) => t.tag)).toContain("work");
      expect(tagsResult.value.map((t) => t.tag)).toContain("project");
      expect(tagsResult.value.every((t) => t.source === "frontmatter")).toBe(
        true
      );
    });

    test("sets user tags for document", async () => {
      const docId = await createTestDoc("notes", "test.md");

      const result = await adapter.setDocTags(docId, ["favorite"], "user");
      expect(result.ok).toBe(true);

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      expect(tagsResult.value).toHaveLength(1);
      expect(tagsResult.value[0]?.tag).toBe("favorite");
      expect(tagsResult.value[0]?.source).toBe("user");
    });

    test("replaces tags from same source", async () => {
      const docId = await createTestDoc("notes", "test.md");

      // Set initial tags
      await adapter.setDocTags(docId, ["old-tag"], "frontmatter");

      // Replace with new tags
      const result = await adapter.setDocTags(
        docId,
        ["new-tag"],
        "frontmatter"
      );
      expect(result.ok).toBe(true);

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      expect(tagsResult.value).toHaveLength(1);
      expect(tagsResult.value[0]?.tag).toBe("new-tag");
    });

    test("preserves user tags when updating frontmatter tags", async () => {
      const docId = await createTestDoc("notes", "test.md");

      // Set user tag
      await adapter.setDocTags(docId, ["favorite"], "user");

      // Set frontmatter tags
      await adapter.setDocTags(docId, ["work"], "frontmatter");

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      expect(tagsResult.value).toHaveLength(2);
      expect(tagsResult.value.map((t) => t.tag).sort()).toEqual([
        "favorite",
        "work",
      ]);
    });

    test("handles empty tags array", async () => {
      const docId = await createTestDoc("notes", "test.md");

      // Set tags then clear
      await adapter.setDocTags(docId, ["work"], "frontmatter");
      const result = await adapter.setDocTags(docId, [], "frontmatter");
      expect(result.ok).toBe(true);

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      expect(tagsResult.value).toHaveLength(0);
    });

    test("handles duplicate tags gracefully", async () => {
      const docId = await createTestDoc("notes", "test.md");

      // Same tag from both sources - only one should exist
      await adapter.setDocTags(docId, ["shared"], "frontmatter");
      await adapter.setDocTags(docId, ["shared"], "user");

      const tagsResult = await adapter.getTagsForDoc(docId);
      expect(tagsResult.ok).toBe(true);
      if (!tagsResult.ok) return;

      // Primary key is (document_id, tag), so only one entry
      expect(tagsResult.value).toHaveLength(1);
    });
  });

  describe("getTagsForDoc", () => {
    test("returns empty array for document with no tags", async () => {
      const docId = await createTestDoc("notes", "test.md");

      const result = await adapter.getTagsForDoc(docId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual([]);
    });

    test("returns tags sorted alphabetically", async () => {
      const docId = await createTestDoc("notes", "test.md");

      await adapter.setDocTags(
        docId,
        ["zebra", "alpha", "beta"],
        "frontmatter"
      );

      const result = await adapter.getTagsForDoc(docId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.map((t) => t.tag)).toEqual([
        "alpha",
        "beta",
        "zebra",
      ]);
    });
  });

  describe("getTagCounts", () => {
    test("counts tags across documents", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await adapter.setDocTags(doc1, ["work", "project"], "frontmatter");
      await adapter.setDocTags(doc2, ["work", "personal"], "frontmatter");
      await adapter.setDocTags(doc3, ["work"], "frontmatter");

      const result = await adapter.getTagCounts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // work: 3, project: 1, personal: 1
      const workCount = result.value.find((t) => t.tag === "work");
      const projectCount = result.value.find((t) => t.tag === "project");
      const personalCount = result.value.find((t) => t.tag === "personal");

      expect(workCount?.count).toBe(3);
      expect(projectCount?.count).toBe(1);
      expect(personalCount?.count).toBe(1);
    });

    test("filters by collection", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("docs", "doc2.md", "hash2");

      await adapter.setDocTags(doc1, ["work"], "frontmatter");
      await adapter.setDocTags(doc2, ["work"], "frontmatter");

      const result = await adapter.getTagCounts({ collection: "notes" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const workCount = result.value.find((t) => t.tag === "work");
      expect(workCount?.count).toBe(1);
    });

    test("filters by tag prefix", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");

      await adapter.setDocTags(
        doc1,
        ["project/frontend", "project/backend"],
        "frontmatter"
      );
      await adapter.setDocTags(doc2, ["personal", "project"], "frontmatter");

      const result = await adapter.getTagCounts({ prefix: "project" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should include: project, project/frontend, project/backend
      const tags = result.value.map((t) => t.tag);
      expect(tags).toContain("project");
      expect(tags).toContain("project/frontend");
      expect(tags).toContain("project/backend");
      expect(tags).not.toContain("personal");
    });

    test("returns tags ordered by count descending", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await adapter.setDocTags(doc1, ["rare", "common"], "frontmatter");
      await adapter.setDocTags(doc2, ["common", "medium"], "frontmatter");
      await adapter.setDocTags(doc3, ["common", "medium"], "frontmatter");

      const result = await adapter.getTagCounts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // common: 3, medium: 2, rare: 1
      expect(result.value[0]?.tag).toBe("common");
      expect(result.value[0]?.count).toBe(3);
    });

    test("excludes inactive documents", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");

      await adapter.setDocTags(doc1, ["active-tag"], "frontmatter");
      await adapter.setDocTags(doc2, ["inactive-tag"], "frontmatter");

      // Mark doc2 as inactive
      await adapter.markInactive("notes", ["doc2.md"]);

      const result = await adapter.getTagCounts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const tags = result.value.map((t) => t.tag);
      expect(tags).toContain("active-tag");
      expect(tags).not.toContain("inactive-tag");
    });
  });

  describe("searchFts with tag filters", () => {
    beforeEach(async () => {
      // Create test documents with content and tags
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await adapter.setDocTags(doc1, ["work", "urgent"], "frontmatter");
      await adapter.setDocTags(doc2, ["work", "personal"], "frontmatter");
      await adapter.setDocTags(doc3, ["personal"], "frontmatter");

      // Add content for FTS
      await adapter.upsertContent("hash1", "Meeting notes for the project");
      await adapter.upsertContent("hash2", "Personal project notes");
      await adapter.upsertContent("hash3", "Personal journal entry");

      // Sync to FTS
      await adapter.syncDocumentFts("notes", "doc1.md");
      await adapter.syncDocumentFts("notes", "doc2.md");
      await adapter.syncDocumentFts("notes", "doc3.md");
    });

    test("tagsAny filters to docs with any matching tag", async () => {
      const result = await adapter.searchFts("notes", {
        tagsAny: ["urgent"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only doc1 has urgent tag
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.relPath).toBe("doc1.md");
    });

    test("tagsAll filters to docs with all matching tags", async () => {
      const result = await adapter.searchFts("notes", {
        tagsAll: ["work", "personal"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Only doc2 has both work and personal
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.relPath).toBe("doc2.md");
    });

    test("combined tagsAny and tagsAll", async () => {
      const result = await adapter.searchFts("notes", {
        tagsAny: ["work"],
        tagsAll: ["personal"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // doc2 has work AND personal
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.relPath).toBe("doc2.md");
    });
  });

  describe("ingestVersion", () => {
    test("stores ingest version in document", async () => {
      const doc: DocumentInput = {
        collection: "notes",
        relPath: "test.md",
        sourceHash: "abc123",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        ingestVersion: 2,
      };

      const upsertResult = await adapter.upsertDocument(doc);
      expect(upsertResult.ok).toBe(true);

      const getResult = await adapter.getDocument("notes", "test.md");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value?.ingestVersion).toBe(2);
    });

    test("existing docs have null ingest version", async () => {
      // Create doc without ingestVersion (simulating pre-migration doc)
      const doc: DocumentInput = {
        collection: "notes",
        relPath: "old.md",
        sourceHash: "old123",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        // No ingestVersion
      };

      await adapter.upsertDocument(doc);

      const getResult = await adapter.getDocument("notes", "old.md");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      // ingestVersion should be null for docs created without it
      expect(getResult.value?.ingestVersion).toBeNull();
    });
  });
});
