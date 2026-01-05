/**
 * Unit tests for document link API endpoints.
 */

import { describe, expect, test } from "bun:test";

import type {
  BacklinkRow,
  DocLinkRow,
  StoreResult,
} from "../../../src/store/types";

import {
  handleDocBacklinks,
  handleDocLinks,
  handleDocSimilar,
} from "../../../src/serve/routes/links";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Store
// ─────────────────────────────────────────────────────────────────────────────

function createMockStore(options: {
  doc?: { id: number; docid: string; mirrorHash?: string };
  links?: DocLinkRow[];
  backlinks?: BacklinkRow[];
  content?: string;
  resolveLinksResult?: StoreResult<
    Array<{ docid: string; uri: string; title: string | null } | null>
  >;
}) {
  return {
    getDocumentByDocid(docid: string) {
      if (options.doc && options.doc.docid === docid) {
        return Promise.resolve({ ok: true as const, value: options.doc });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    getLinksForDoc(_documentId: number) {
      return Promise.resolve({ ok: true as const, value: options.links ?? [] });
    },
    getBacklinksForDoc(_documentId: number) {
      return Promise.resolve({
        ok: true as const,
        value: options.backlinks ?? [],
      });
    },
    getContent(_mirrorHash: string) {
      return Promise.resolve({
        ok: true as const,
        value: options.content ?? null,
      });
    },
    listDocuments(_collection?: string) {
      return Promise.resolve({ ok: true as const, value: [] });
    },
    resolveLinks(
      _targets: Array<{
        targetRefNorm: string;
        targetCollection: string;
        linkType: "wiki" | "markdown";
      }>
    ) {
      if (options.resolveLinksResult) {
        return Promise.resolve(options.resolveLinksResult);
      }
      // Return null for all targets (unresolved) - tests don't need resolved links
      return Promise.resolve({
        ok: true as const,
        value: _targets.map(() => null),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LinkApiResponse {
  links: Array<{
    targetRef: string;
    linkType: "wiki" | "markdown";
    startLine: number;
    resolved?: boolean;
  }>;
  meta: {
    totalLinks: number;
    docid: string;
    resolvedCount: number;
    resolutionAvailable: boolean;
    typeFilter?: string;
  };
}

interface BacklinkApiResponse {
  backlinks: Array<{
    sourceDocid: string;
    sourceUri: string;
  }>;
  meta: { totalBacklinks: number; docid: string };
}

interface ErrorResponse {
  error: { code: string; message: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/doc/:id/links", () => {
  test("returns 200 with links and meta", async () => {
    const links: DocLinkRow[] = [
      {
        targetRef: "Other Note",
        targetRefNorm: "other note",
        targetAnchor: null,
        targetCollection: null,
        linkType: "wiki",
        linkText: null,
        startLine: 5,
        startCol: 1,
        endLine: 5,
        endCol: 16,
        source: "parsed",
      },
      {
        targetRef: "./file.md",
        targetRefNorm: "file.md",
        targetAnchor: "section",
        targetCollection: null,
        linkType: "markdown",
        linkText: "link text",
        startLine: 10,
        startCol: 1,
        endLine: 10,
        endCol: 30,
        source: "parsed",
      },
    ];

    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      links,
    });

    const url = new URL("http://localhost/api/doc/%23abc123/links");
    const res = await handleDocLinks(store as never, "#abc123", url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as LinkApiResponse;
    expect(body.links).toBeArrayOfSize(2);
    expect(body.links[0]?.targetRef).toBe("Other Note");
    expect(body.links[0]?.linkType).toBe("wiki");
    expect(body.links[1]?.targetRef).toBe("./file.md");
    expect(body.links[1]?.linkType).toBe("markdown");
    expect(body.meta.totalLinks).toBe(2);
    expect(body.meta.docid).toBe("#abc123");
  });

  test("filters by type=wiki", async () => {
    const links: DocLinkRow[] = [
      {
        targetRef: "Wiki Link",
        targetRefNorm: "wiki link",
        targetAnchor: null,
        targetCollection: null,
        linkType: "wiki",
        linkText: null,
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 15,
        source: "parsed",
      },
      {
        targetRef: "./md.md",
        targetRefNorm: "md.md",
        targetAnchor: null,
        targetCollection: null,
        linkType: "markdown",
        linkText: null,
        startLine: 2,
        startCol: 1,
        endLine: 2,
        endCol: 15,
        source: "parsed",
      },
    ];

    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      links,
    });

    const url = new URL("http://localhost/api/doc/%23abc123/links?type=wiki");
    const res = await handleDocLinks(store as never, "#abc123", url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as LinkApiResponse;
    expect(body.links).toBeArrayOfSize(1);
    expect(body.links[0]?.linkType).toBe("wiki");
    expect(body.meta.typeFilter).toBe("wiki");
  });

  test("returns 404 when doc not found", async () => {
    const store = createMockStore({});

    const url = new URL("http://localhost/api/doc/%23notfound/links");
    const res = await handleDocLinks(store as never, "#notfound", url);

    expect(res.status).toBe(404);

    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns empty array when no links", async () => {
    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      links: [],
    });

    const url = new URL("http://localhost/api/doc/%23abc123/links");
    const res = await handleDocLinks(store as never, "#abc123", url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as LinkApiResponse;
    expect(body.links).toBeArrayOfSize(0);
    expect(body.meta.totalLinks).toBe(0);
  });

  test("omits resolved fields when resolution unavailable", async () => {
    const links: DocLinkRow[] = [
      {
        targetRef: "Other Note",
        targetRefNorm: "other note",
        targetAnchor: null,
        targetCollection: null,
        linkType: "wiki",
        linkText: null,
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 16,
        source: "parsed",
      },
    ];

    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      links,
      resolveLinksResult: {
        ok: false,
        error: { code: "QUERY_FAILED", message: "resolve fail" },
      },
    });

    const url = new URL("http://localhost/api/doc/%23abc123/links");
    const res = await handleDocLinks(store as never, "#abc123", url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as LinkApiResponse;
    expect(body.meta.resolutionAvailable).toBe(false);
    expect(body.links).toBeArrayOfSize(1);
    expect("resolved" in body.links[0]!).toBe(false);
  });
});

describe("GET /api/doc/:id/backlinks", () => {
  test("returns 200 with backlinks and meta", async () => {
    const backlinks: BacklinkRow[] = [
      {
        sourceDocId: 2,
        sourceDocid: "#abc456",
        sourceDocUri: "gno://notes/source.md",
        sourceDocTitle: "Source Doc",
        linkText: "link to target",
        startLine: 10,
        startCol: 5,
      },
      {
        sourceDocId: 3,
        sourceDocid: "#def789",
        sourceDocUri: "gno://notes/another.md",
        sourceDocTitle: null,
        linkText: null,
        startLine: 20,
        startCol: 1,
      },
    ];

    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      backlinks,
    });

    const res = await handleDocBacklinks(store as never, "#abc123");

    expect(res.status).toBe(200);

    const body = (await res.json()) as BacklinkApiResponse;
    expect(body.backlinks).toBeArrayOfSize(2);
    // Sorted alphabetically by sourceUri: another.md comes before source.md
    expect(body.backlinks[0]?.sourceUri).toBe("gno://notes/another.md");
    expect(body.backlinks[0]?.sourceDocid).toBe("#def789");
    expect(body.backlinks[1]?.sourceUri).toBe("gno://notes/source.md");
    expect(body.backlinks[1]?.sourceDocid).toBe("#abc456");
    expect(body.meta.totalBacklinks).toBe(2);
    expect(body.meta.docid).toBe("#abc123");
  });

  test("returns 404 when doc not found", async () => {
    const store = createMockStore({});

    const res = await handleDocBacklinks(store as never, "#notfound");

    expect(res.status).toBe(404);

    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns empty array when no backlinks", async () => {
    const store = createMockStore({
      doc: { id: 1, docid: "#abc123" },
      backlinks: [],
    });

    const res = await handleDocBacklinks(store as never, "#abc123");

    expect(res.status).toBe(200);

    const body = (await res.json()) as BacklinkApiResponse;
    expect(body.backlinks).toBeArrayOfSize(0);
    expect(body.meta.totalBacklinks).toBe(0);
  });
});

describe("GET /api/doc/:id/similar", () => {
  test("returns 503 when vector search unavailable", async () => {
    const store = createMockStore({
      doc: { id: 1, docid: "#abc123", mirrorHash: "hash1" },
      content: "Test content",
    });

    // Mock context without vector capabilities
    const ctx = {
      store,
      vectorIndex: null,
      embedPort: null,
    };

    const url = new URL("http://localhost/api/doc/%23abc123/similar");
    const res = await handleDocSimilar(ctx as never, "#abc123", url);

    expect(res.status).toBe(503);

    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("UNAVAILABLE");
  });

  test("returns 404 when doc not found", async () => {
    const store = createMockStore({});

    const ctx = {
      store,
      vectorIndex: { searchAvailable: true },
      embedPort: {},
    };

    const url = new URL("http://localhost/api/doc/%23notfound/similar");
    const res = await handleDocSimilar(ctx as never, "#notfound", url);

    expect(res.status).toBe(404);

    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns empty when doc has no content", async () => {
    const store = createMockStore({
      doc: { id: 1, docid: "#abc123", mirrorHash: undefined },
    });

    const ctx = {
      store,
      vectorIndex: { searchAvailable: true },
      embedPort: {},
    };

    const url = new URL("http://localhost/api/doc/%23abc123/similar");
    const res = await handleDocSimilar(ctx as never, "#abc123", url);

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      similar: unknown[];
      meta: { totalResults: number };
    };
    expect(body.similar).toBeArrayOfSize(0);
    expect(body.meta.totalResults).toBe(0);
  });
});
