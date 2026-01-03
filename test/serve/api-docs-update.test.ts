/**
 * Tests for PUT /api/docs/:id endpoint.
 *
 * Tests are hermetic using temp directories.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";
import type { DocumentRow } from "../../src/store/types";

import { handleUpdateDoc } from "../../src/serve/routes/api";

interface ErrorBody {
  error: { code: string; message: string };
}

interface SuccessBody {
  success: boolean;
  docId: string;
  uri: string;
  path: string;
  jobId: string | null;
}

// Minimal mock store for testing
function createMockStore(docs: DocumentRow[] = []) {
  return {
    getDocumentByDocid(docId: string) {
      const doc = docs.find((d) => d.docid === docId);
      return Promise.resolve({ ok: true as const, value: doc ?? null });
    },
  };
}

// Minimal mock context holder
function createMockContextHolder(config?: Partial<Config>): ContextHolder {
  const fullConfig: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    ...config,
  };
  return {
    current: { config: fullConfig } as ContextHolder["current"],
    config: fullConfig,
  };
}

describe("PUT /api/docs/:id", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("rejects missing content", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/docs/abc123", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await handleUpdateDoc(ctxHolder, store as never, "abc123", req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION");
  });

  test("rejects invalid content type", async () => {
    const store = createMockStore();
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/docs/abc123", {
      method: "PUT",
      body: JSON.stringify({ content: 123 }),
    });
    const res = await handleUpdateDoc(ctxHolder, store as never, "abc123", req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION");
  });

  test("returns 404 for non-existent document", async () => {
    const store = createMockStore([]);
    const ctxHolder = createMockContextHolder();
    const req = new Request("http://localhost/api/docs/nonexistent", {
      method: "PUT",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "nonexistent",
      req
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 404 when collection not in config", async () => {
    const docs: DocumentRow[] = [
      {
        id: 1,
        collection: "orphan-collection",
        relPath: "test.md",
        sourceHash: "abc",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#abc123",
        uri: "gno://orphan-collection/test.md",
        title: "Test",
        mirrorHash: null,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(docs);
    const ctxHolder = createMockContextHolder({ collections: [] });
    const req = new Request("http://localhost/api/docs/abc123", {
      method: "PUT",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Collection not found");
  });

  test("returns 404 when source file missing", async () => {
    const docs: DocumentRow[] = [
      {
        id: 1,
        collection: "notes",
        relPath: "missing.md",
        sourceHash: "abc",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#abc123",
        uri: "gno://notes/missing.md",
        title: "Missing",
        mirrorHash: null,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(docs);
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });
    const req = new Request("http://localhost/api/docs/abc123", {
      method: "PUT",
      body: JSON.stringify({ content: "test" }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("FILE_NOT_FOUND");
  });

  test("successfully updates existing file", async () => {
    // Create the test file
    const testFilePath = join(tmpDir, "test.md");
    await writeFile(testFilePath, "# Original content");

    const docs: DocumentRow[] = [
      {
        id: 1,
        collection: "notes",
        relPath: "test.md",
        sourceHash: "abc",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#abc123",
        uri: "gno://notes/test.md",
        title: "Test",
        mirrorHash: null,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(docs);
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const newContent = "# Updated content\n\nNew text here.";
    const req = new Request("http://localhost/api/docs/abc123", {
      method: "PUT",
      body: JSON.stringify({ content: newContent }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessBody;
    expect(body.success).toBe(true);
    expect(body.docId).toBe("#abc123");
    expect(body.path).toBe(testFilePath);

    // Verify file was updated
    const updatedContent = await Bun.file(testFilePath).text();
    expect(updatedContent).toBe(newContent);
  });

  test("handles nested paths", async () => {
    // Create nested directory and file
    const nestedDir = join(tmpDir, "sub", "folder");
    await mkdir(nestedDir, { recursive: true });
    const testFilePath = join(nestedDir, "nested.md");
    await writeFile(testFilePath, "Original");

    const docs: DocumentRow[] = [
      {
        id: 1,
        collection: "notes",
        relPath: "sub/folder/nested.md",
        sourceHash: "abc",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#nested123",
        uri: "gno://notes/sub/folder/nested.md",
        title: "Nested",
        mirrorHash: null,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(docs);
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
    });

    const req = new Request("http://localhost/api/docs/nested123", {
      method: "PUT",
      body: JSON.stringify({ content: "Updated nested" }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "#nested123",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessBody;
    expect(body.success).toBe(true);

    // Verify nested file was updated
    const updatedContent = await Bun.file(testFilePath).text();
    expect(updatedContent).toBe("Updated nested");
  });

  test("collection lookup is case-insensitive", async () => {
    const testFilePath = join(tmpDir, "test.md");
    await writeFile(testFilePath, "Original");

    const docs: DocumentRow[] = [
      {
        id: 1,
        collection: "NOTES", // uppercase in DB
        relPath: "test.md",
        sourceHash: "abc",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: new Date().toISOString(),
        docid: "#case123",
        uri: "gno://NOTES/test.md",
        title: "Test",
        mirrorHash: null,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        active: true,
        ingestVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    const store = createMockStore(docs);
    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        }, // lowercase in config
      ],
    });

    const req = new Request("http://localhost/api/docs/case123", {
      method: "PUT",
      body: JSON.stringify({ content: "Updated" }),
    });
    const res = await handleUpdateDoc(
      ctxHolder,
      store as never,
      "#case123",
      req
    );
    expect(res.status).toBe(200);
  });
});
