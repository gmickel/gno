/**
 * Integration tests for tag-related API endpoints.
 *
 * These tests use a real SQLite database with the full adapter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { handleDocs, handleTags } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

describe("API tag endpoints", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-api-tags-"));
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a test document
   */
  async function createTestDoc(
    collection: string,
    relPath: string,
    hash: string
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
      mirrorHash: hash,
      ingestVersion: 2,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Failed to create test doc");
    return result.value.id;
  }

  describe("GET /api/tags", () => {
    test("returns tags with counts and meta from real store", async () => {
      // Create docs with tags
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await store.setDocTags(doc1, ["work", "urgent"], "frontmatter");
      await store.setDocTags(doc2, ["work", "meeting"], "frontmatter");
      await store.setDocTags(doc3, ["work"], "frontmatter");

      const url = new URL("http://localhost/api/tags");
      const res = await handleTags(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        tags: Array<{ tag: string; count: number }>;
        meta: { totalTags: number };
      };
      expect(body.tags).toBeArrayOfSize(3);
      expect(body.meta.totalTags).toBe(3);

      // work: 3, urgent: 1, meeting: 1
      const workTag = body.tags.find((t) => t.tag === "work");
      expect(workTag?.count).toBe(3);
    });

    test("filters by collection and includes in meta", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("docs", "doc2.md", "hash2");

      await store.setDocTags(doc1, ["notes-tag"], "frontmatter");
      await store.setDocTags(doc2, ["docs-tag"], "frontmatter");

      const url = new URL("http://localhost/api/tags?collection=notes");
      const res = await handleTags(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        tags: Array<{ tag: string; count: number }>;
        meta: { total: number; collection?: string };
      };
      expect(body.tags).toBeArrayOfSize(1);
      expect(body.tags[0]?.tag).toBe("notes-tag");
      expect(body.meta.collection).toBe("notes");
    });

    test("filters by prefix and includes in meta", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");

      await store.setDocTags(
        doc1,
        ["project/alpha", "project/beta"],
        "frontmatter"
      );
      await store.setDocTags(doc2, ["personal", "project"], "frontmatter");

      const url = new URL("http://localhost/api/tags?prefix=project");
      const res = await handleTags(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        tags: Array<{ tag: string; count: number }>;
        meta: { total: number; prefix?: string };
      };
      // Should include project, project/alpha, project/beta
      const tags = body.tags.map((t) => t.tag);
      expect(tags).toContain("project");
      expect(tags).toContain("project/alpha");
      expect(tags).toContain("project/beta");
      expect(tags).not.toContain("personal");
      expect(body.meta.prefix).toBe("project");
    });
  });

  describe("GET /api/docs with tag filters", () => {
    test("tagsAny filters documents", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await store.setDocTags(doc1, ["work", "urgent"], "frontmatter");
      await store.setDocTags(doc2, ["personal"], "frontmatter");
      await store.setDocTags(doc3, ["work"], "frontmatter");

      const url = new URL("http://localhost/api/docs?tagsAny=urgent");
      const res = await handleDocs(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        documents: Array<{ relPath: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.documents[0]?.relPath).toBe("doc1.md");
    });

    test("tagsAll filters documents with multiple tags", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await store.setDocTags(doc1, ["work", "urgent"], "frontmatter");
      await store.setDocTags(doc2, ["work"], "frontmatter");
      await store.setDocTags(doc3, ["urgent"], "frontmatter");

      // Filter by both work AND urgent
      const url = new URL("http://localhost/api/docs?tagsAll=work,urgent");
      const res = await handleDocs(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        documents: Array<{ relPath: string }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.documents[0]?.relPath).toBe("doc1.md");
    });

    test("combined tagsAny and tagsAll", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");
      const doc3 = await createTestDoc("notes", "doc3.md", "hash3");

      await store.setDocTags(doc1, ["work", "urgent", "high"], "frontmatter");
      await store.setDocTags(doc2, ["work", "personal"], "frontmatter");
      await store.setDocTags(doc3, ["personal", "urgent"], "frontmatter");

      // tagsAll=work tagsAny=urgent,high
      // doc1: has work AND (urgent OR high) -> should match
      // doc2: has work but NOT (urgent OR high) -> should NOT match
      // doc3: NOT work -> should NOT match
      const url = new URL(
        "http://localhost/api/docs?tagsAll=work&tagsAny=urgent,high"
      );
      const res = await handleDocs(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        documents: Array<{ relPath: string }>;
        total: number;
      };

      // doc1 has work AND (urgent OR high)
      expect(body.total).toBe(1);
      expect(body.documents[0]?.relPath).toBe("doc1.md");
    });

    test("returns all docs when no tag filter", async () => {
      const doc1 = await createTestDoc("notes", "doc1.md", "hash1");
      const doc2 = await createTestDoc("notes", "doc2.md", "hash2");

      await store.setDocTags(doc1, ["work"], "frontmatter");
      await store.setDocTags(doc2, ["personal"], "frontmatter");

      const url = new URL("http://localhost/api/docs");
      const res = await handleDocs(store, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(2);
    });

    test("invalid tagsAll returns 400", async () => {
      // Invalid tag with spaces
      const url = new URL("http://localhost/api/docs?tagsAll=invalid%20tag");
      const res = await handleDocs(store, url);

      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION");
    });
  });
});
