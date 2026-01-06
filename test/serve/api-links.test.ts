/**
 * Integration tests for document links API endpoints.
 *
 * These tests use a real SQLite database with the full adapter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocLinkInput, DocumentInput } from "../../src/store/types";

import {
  handleDocBacklinks,
  handleDocLinks,
} from "../../src/serve/routes/links";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("API link endpoints", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-api-links-"));
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
    ];
    const syncResult = await store.syncCollections(collections);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  /**
   * Helper to create a test document
   */
  async function createTestDoc(
    relPath: string,
    hash: string,
    title?: string
  ): Promise<{ id: number; docid: string }> {
    const doc: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 100,
      sourceMtime: new Date().toISOString(),
      title: title ?? relPath,
      mirrorHash: hash,
      ingestVersion: 2,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Failed to create test doc");
    return { id: result.value.id, docid: result.value.docid };
  }

  describe("GET /api/doc/:id/links", () => {
    test("returns outgoing links for a document", async () => {
      const doc = await createTestDoc("source.md", "hash1", "Source Doc");

      // Add wiki and markdown links
      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note",
          linkType: "wiki",
          startLine: 5,
          startCol: 1,
          endLine: 5,
          endCol: 17,
        },
        {
          targetRef: "./other.md",
          targetRefNorm: "other.md",
          targetAnchor: "section",
          linkType: "markdown",
          linkText: "other doc",
          startLine: 10,
          startCol: 1,
          endLine: 10,
          endCol: 25,
        },
      ];
      const setResult = await store.setDocLinks(doc.id, links, "parsed");
      expect(setResult.ok).toBe(true);

      const url = new URL(
        `http://localhost/api/doc/${encodeURIComponent(doc.docid)}/links`
      );
      const res = await handleDocLinks(store, doc.docid, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        links: Array<{
          targetRef: string;
          linkType: string;
          targetAnchor?: string;
          linkText?: string;
        }>;
        meta: { totalLinks: number; docid: string };
      };

      expect(body.links).toBeArrayOfSize(2);
      expect(body.meta.totalLinks).toBe(2);
      expect(body.meta.docid).toBe(doc.docid);

      // Check wiki link
      const wikiLink = body.links.find((l) => l.linkType === "wiki");
      expect(wikiLink?.targetRef).toBe("Target Note");

      // Check markdown link with anchor
      const mdLink = body.links.find((l) => l.linkType === "markdown");
      expect(mdLink?.targetRef).toBe("./other.md");
      expect(mdLink?.targetAnchor).toBe("section");
      expect(mdLink?.linkText).toBe("other doc");
    });

    test("filters by type=wiki", async () => {
      const doc = await createTestDoc("source.md", "hash1");

      const links: DocLinkInput[] = [
        {
          targetRef: "Wiki",
          targetRefNorm: "wiki",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 10,
        },
        {
          targetRef: "./md.md",
          targetRefNorm: "md.md",
          linkType: "markdown",
          startLine: 2,
          startCol: 1,
          endLine: 2,
          endCol: 15,
        },
      ];
      await store.setDocLinks(doc.id, links, "parsed");

      const url = new URL(
        `http://localhost/api/doc/${encodeURIComponent(doc.docid)}/links?type=wiki`
      );
      const res = await handleDocLinks(store, doc.docid, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        links: Array<{ linkType: string }>;
        meta: { typeFilter?: string };
      };

      expect(body.links).toBeArrayOfSize(1);
      expect(body.links[0]?.linkType).toBe("wiki");
      expect(body.meta.typeFilter).toBe("wiki");
    });

    test("filters by type=markdown", async () => {
      const doc = await createTestDoc("source.md", "hash1");

      const links: DocLinkInput[] = [
        {
          targetRef: "Wiki",
          targetRefNorm: "wiki",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 10,
        },
        {
          targetRef: "./md.md",
          targetRefNorm: "md.md",
          linkType: "markdown",
          startLine: 2,
          startCol: 1,
          endLine: 2,
          endCol: 15,
        },
      ];
      await store.setDocLinks(doc.id, links, "parsed");

      const url = new URL(
        `http://localhost/api/doc/${encodeURIComponent(doc.docid)}/links?type=markdown`
      );
      const res = await handleDocLinks(store, doc.docid, url);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        links: Array<{ linkType: string }>;
        meta: { typeFilter?: string };
      };

      expect(body.links).toBeArrayOfSize(1);
      expect(body.links[0]?.linkType).toBe("markdown");
      expect(body.meta.typeFilter).toBe("markdown");
    });

    test("returns 404 for non-existent document", async () => {
      const url = new URL("http://localhost/api/doc/%23notfound/links");
      const res = await handleDocLinks(store, "#notfound", url);

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /api/doc/:id/backlinks", () => {
    test("returns backlinks for wiki link target", async () => {
      // Create target doc
      const target = await createTestDoc("target.md", "hash1", "Target Note");

      // Create source doc with wiki link to target
      const source = await createTestDoc("source.md", "hash2", "Source Doc");

      // Add wiki link from source to target (by title)
      const links: DocLinkInput[] = [
        {
          targetRef: "Target Note",
          targetRefNorm: "target note", // Normalized title
          linkType: "wiki",
          linkText: "see target",
          startLine: 5,
          startCol: 1,
          endLine: 5,
          endCol: 20,
        },
      ];
      await store.setDocLinks(source.id, links, "parsed");

      const res = await handleDocBacklinks(store, target.docid);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        backlinks: Array<{
          sourceDocid: string;
          sourceUri: string;
          sourceTitle?: string;
          linkText?: string;
        }>;
        meta: { totalBacklinks: number; docid: string };
      };

      expect(body.backlinks).toBeArrayOfSize(1);
      expect(body.backlinks[0]?.sourceDocid).toBe(source.docid);
      expect(body.backlinks[0]?.sourceTitle).toBe("Source Doc");
      expect(body.backlinks[0]?.linkText).toBe("see target");
      expect(body.meta.totalBacklinks).toBe(1);
      expect(body.meta.docid).toBe(target.docid);
    });

    test("returns backlinks for markdown link target", async () => {
      // Create target doc
      const target = await createTestDoc("target.md", "hash1", "Target");

      // Create source doc with markdown link to target
      const source = await createTestDoc("source.md", "hash2", "Source");

      // Add markdown link from source to target (by relPath)
      const links: DocLinkInput[] = [
        {
          targetRef: "target.md",
          targetRefNorm: "target.md", // For markdown, targetRefNorm = relPath
          linkType: "markdown",
          linkText: "link text",
          startLine: 10,
          startCol: 1,
          endLine: 10,
          endCol: 25,
        },
      ];
      await store.setDocLinks(source.id, links, "parsed");

      const res = await handleDocBacklinks(store, target.docid);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        backlinks: Array<{ sourceDocid: string }>;
        meta: { totalBacklinks: number };
      };

      expect(body.backlinks).toBeArrayOfSize(1);
      expect(body.backlinks[0]?.sourceDocid).toBe(source.docid);
    });

    test("returns multiple backlinks from different sources", async () => {
      const target = await createTestDoc("target.md", "hash1", "Target Note");
      const source1 = await createTestDoc("source1.md", "hash2", "Source 1");
      const source2 = await createTestDoc("source2.md", "hash3", "Source 2");

      // Both sources link to target
      await store.setDocLinks(
        source1.id,
        [
          {
            targetRef: "Target Note",
            targetRefNorm: "target note",
            linkType: "wiki",
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 15,
          },
        ],
        "parsed"
      );
      await store.setDocLinks(
        source2.id,
        [
          {
            targetRef: "Target Note",
            targetRefNorm: "target note",
            linkType: "wiki",
            startLine: 2,
            startCol: 1,
            endLine: 2,
            endCol: 15,
          },
        ],
        "parsed"
      );

      const res = await handleDocBacklinks(store, target.docid);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        backlinks: Array<{ sourceDocId: number }>;
        meta: { totalBacklinks: number };
      };

      expect(body.backlinks).toBeArrayOfSize(2);
      expect(body.meta.totalBacklinks).toBe(2);
    });

    test("returns empty when no backlinks exist", async () => {
      const doc = await createTestDoc("lonely.md", "hash1", "Lonely Doc");

      const res = await handleDocBacklinks(store, doc.docid);

      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        backlinks: unknown[];
        meta: { totalBacklinks: number };
      };

      expect(body.backlinks).toBeArrayOfSize(0);
      expect(body.meta.totalBacklinks).toBe(0);
    });

    test("returns 404 for non-existent document", async () => {
      const res = await handleDocBacklinks(store, "#notfound");

      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });
  });
});
