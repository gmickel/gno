import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";
import type { DocumentRow, StoreResult } from "../../src/store/types";

import {
  handleCreateCapture,
  handleCreateDoc,
  handleCreateFolder,
  handleDeactivateDoc,
  handleDuplicateDoc,
  handleMoveDoc,
  handleRenameDoc,
  handleRevealDoc,
  handleTrashDoc,
  routeApi,
} from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

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
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

function createMockStore(
  docsInput: DocumentRow | DocumentRow[],
  overrides?: {
    markInactive?: () => Promise<StoreResult<number>>;
  }
) {
  const docs = Array.isArray(docsInput) ? docsInput : [docsInput];
  return {
    getDocumentByDocid(id: string) {
      const doc = docs.find((entry) => entry.docid === id);
      return Promise.resolve({
        ok: true as const,
        value: doc ?? null,
      });
    },
    getDocumentByUri(uri: string) {
      const doc = docs.find((entry) => entry.uri === uri);
      return Promise.resolve({
        ok: true as const,
        value: doc ?? null,
      });
    },
    markInactive() {
      if (overrides?.markInactive) {
        return overrides.markInactive();
      }
      return Promise.resolve({ ok: true as const, value: 1 });
    },
  };
}

function createDoc(
  tmpDir: string,
  overrides: Partial<DocumentRow> = {}
): DocumentRow {
  return {
    id: 1,
    collection: "notes",
    relPath: "doc.md",
    sourceHash: "hash",
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: new Date().toISOString(),
    docid: "#abc123",
    uri: "gno://notes/doc.md",
    title: "Doc",
    mirrorHash: "mirror",
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
    ...overrides,
  };
}

describe("document lifecycle API", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-lifecycle-"));
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("deactivation advances resident content and index generations", async () => {
    const doc = createDoc(tmpDir);
    const ctxHolder = createMockContextHolder();
    let contentGeneration = 0;
    let indexGeneration = 0;
    ctxHolder.markContentMutation = () => {
      contentGeneration += 1;
    };
    ctxHolder.markIndexMutation = () => {
      indexGeneration += 1;
    };

    const response = await handleDeactivateDoc(
      ctxHolder,
      createMockStore(doc) as never,
      doc.docid
    );

    expect(response.status).toBe(200);
    expect(contentGeneration).toBe(1);
    expect(indexGeneration).toBe(1);
  });

  test("renames editable markdown files", async () => {
    const doc = createDoc(tmpDir);
    const sourcePath = join(tmpDir, "doc.md");
    await writeFile(sourcePath, "# Hello");

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
    const store = createMockStore(doc);
    const req = new Request("http://localhost/api/docs/abc123/rename", {
      method: "POST",
      body: JSON.stringify({ name: "renamed.md" }),
    });

    const res = await handleRenameDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req,
      {
        renameFilePath: async (from, to) => {
          await rename(from, to);
        },
        syncCollection: async () =>
          ({ ok: true as const, value: undefined }) as never,
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; relPath: string };
    expect(body.relPath).toBe("renamed.md");
    expect(body.uri).toBe("gno://notes/renamed.md");
  });

  test("blocks rename for read-only converted docs", async () => {
    const doc = createDoc(tmpDir, {
      relPath: "scan.pdf",
      sourceMime: "application/pdf",
      sourceExt: ".pdf",
    });
    await writeFile(join(tmpDir, "scan.pdf"), "pdf");

    const ctxHolder = createMockContextHolder({
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ],
    });
    const store = createMockStore(doc);
    const req = new Request("http://localhost/api/docs/abc123/rename", {
      method: "POST",
      body: JSON.stringify({ name: "renamed.pdf" }),
    });

    const res = await handleRenameDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req
    );
    expect(res.status).toBe(409);
  });

  test("trashes editable markdown files", async () => {
    const doc = createDoc(tmpDir);
    await writeFile(join(tmpDir, "doc.md"), "# Hello");

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
    const store = createMockStore(doc);

    const res = await handleTrashDoc(
      ctxHolder,
      store as never,
      "#abc123",
      undefined,
      {
        trashFilePath: async () => undefined,
        syncCollection: async () =>
          ({ ok: true as const, value: undefined }) as never,
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; note: string };
    expect(body.success).toBe(true);
    expect(body.note).toContain("Moved to Trash");
  });

  test("rename returns warning when sync fails after file move", async () => {
    const doc = createDoc(tmpDir);
    const sourcePath = join(tmpDir, "doc.md");
    await writeFile(sourcePath, "# Hello");

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
    const store = createMockStore(doc);
    const req = new Request("http://localhost/api/docs/abc123/rename", {
      method: "POST",
      body: JSON.stringify({ name: "renamed.md" }),
    });

    const res = await handleRenameDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req,
      {
        renameFilePath: async (from, to) => {
          await rename(from, to);
        },
        syncCollection: async () => {
          throw new Error("sync failed");
        },
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("index refresh failed");
  });

  test("trash returns warning when sync fails after file move", async () => {
    const doc = createDoc(tmpDir);
    await writeFile(join(tmpDir, "doc.md"), "# Hello");

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
    const store = createMockStore(doc);

    const res = await handleTrashDoc(
      ctxHolder,
      store as never,
      "#abc123",
      undefined,
      {
        trashFilePath: async () => undefined,
        syncCollection: async () => {
          throw new Error("sync failed");
        },
      }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("index refresh failed");
  });

  test("trash returns error when markInactive fails after file move", async () => {
    const doc = createDoc(tmpDir);
    await writeFile(join(tmpDir, "doc.md"), "# Hello");

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

    let syncCalled = false;
    const store = createMockStore(doc, {
      markInactive: async () => ({
        ok: false as const,
        error: {
          code: "QUERY_FAILED",
          message: "database is locked",
        },
      }),
    });

    const res = await handleTrashDoc(
      ctxHolder,
      store as never,
      "#abc123",
      undefined,
      {
        trashFilePath: async () => undefined,
        syncCollection: async () => {
          syncCalled = true;
          return { ok: true as const, value: undefined } as never;
        },
      }
    );

    expect(syncCalled).toBe(false);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("database is locked");
    expect(body.error?.message).toContain("moved to Trash");
  });

  test("reveals supported source files", async () => {
    const doc = createDoc(tmpDir);
    const sourcePath = join(tmpDir, "doc.md");
    await writeFile(sourcePath, "# Hello");

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
    const store = createMockStore(doc);

    let revealedPath = "";
    const res = await handleRevealDoc(
      ctxHolder,
      store as never,
      "#abc123",
      undefined,
      {
        revealFilePath: async (path) => {
          revealedPath = path;
        },
      }
    );

    expect(res.status).toBe(200);
    expect(revealedPath).toBe(sourcePath);
  });

  test("trashes the exact duplicate-content document when uri query is provided", async () => {
    const firstDoc = createDoc(tmpDir, {
      id: 1,
      relPath: "first.md",
      docid: "#samehash",
      uri: "gno://notes/first.md",
      title: "First",
    });
    const secondDoc = createDoc(tmpDir, {
      id: 2,
      relPath: "second.md",
      docid: "#samehash",
      uri: "gno://notes/second.md",
      title: "Second",
    });
    await writeFile(join(tmpDir, "first.md"), "# First");
    await writeFile(join(tmpDir, "second.md"), "# Second");

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
    const store = createMockStore([firstDoc, secondDoc]);

    let trashedPath = "";
    const req = new Request(
      "http://localhost/api/docs/samehash/trash?uri=gno%3A%2F%2Fnotes%2Fsecond.md",
      { method: "POST" }
    );
    const res = await handleTrashDoc(
      ctxHolder,
      store as never,
      "#samehash",
      req,
      {
        trashFilePath: async (path) => {
          trashedPath = path;
        },
        syncCollection: async () =>
          ({ ok: true as const, value: undefined }) as never,
      }
    );

    expect(res.status).toBe(200);
    expect(trashedPath).toBe(join(tmpDir, "second.md"));
  });

  test("creates a new note by title and folder path", async () => {
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
    const store = {
      listDocuments: async () => ({ ok: true as const, value: [] }),
    };
    const req = new Request("http://localhost/api/docs", {
      method: "POST",
      body: JSON.stringify({
        collection: "notes",
        title: "Project Plan",
        folderPath: "projects",
        content: "# Project Plan\n",
      }),
    });

    const res = await handleCreateDoc(ctxHolder, store as never, req);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { relPath: string };
    expect(body.relPath).toBe("projects/project-plan.md");
  });

  test("captures a note with provenance receipt", async () => {
    let contentGeneration = 0;
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
    ctxHolder.markContentMutation = () => {
      contentGeneration += 1;
    };
    const store = {
      listDocuments: async () => ({ ok: true as const, value: [] }),
      getDocument: async () => ({ ok: true as const, value: null }),
    };
    const req = new Request("http://localhost/api/capture", {
      method: "POST",
      body: JSON.stringify({
        collection: "notes",
        content: "Captured from API",
        source: {
          kind: "web",
          url: "https://example.com/api",
        },
      }),
    });

    const res = await handleCreateCapture(ctxHolder, store as never, req, {
      syncCollection: async () => ({
        collection: "notes",
        filesProcessed: 1,
        filesAdded: 1,
        filesUpdated: 0,
        filesUnchanged: 0,
        filesErrored: 0,
        filesSkipped: 0,
        filesMarkedInactive: 0,
        durationMs: 1,
        errors: [],
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      relPath: string;
      source: { kind: string; url: string };
      sync: { status: string; jobId?: string };
      embed: { status: string };
    };
    expect(body.relPath).toStartWith("inbox/");
    expect(body.source.kind).toBe("web");
    expect(body.source.url).toBe("https://example.com/api");
    expect(body.sync.status).toBe("pending");
    expect(body.embed.status).toBe("not_requested");

    const content = await Bun.file(join(tmpDir, body.relPath)).text();
    expect(content).toContain("Captured from API");
    expect(content).toContain("source:");
    await Bun.sleep(20);
    expect(contentGeneration).toBe(1);
  });

  test("rejects invalid capture runtime shapes", async () => {
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
    const store = {
      listDocuments: async () => ({ ok: true as const, value: [] }),
    };

    for (const body of [
      {
        collection: "notes",
        content: "Captured from API",
        source: "web",
      },
      {
        collection: "notes",
        content: "Captured from API",
        tags: "research",
      },
      {
        collection: "notes",
        content: "Captured from API",
        overwrite: true,
      },
    ]) {
      const req = new Request("http://localhost/api/capture", {
        method: "POST",
        body: JSON.stringify(body),
      });

      const res = await handleCreateCapture(ctxHolder, store as never, req);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const responseBody = (await res.json()) as { error: { code: string } };
      expect(responseBody.error.code).toBe("VALIDATION");
    }
  });

  test("fallback router wires POST /api/capture", async () => {
    const existing = createDoc(tmpDir, {
      relPath: "existing.md",
      uri: "gno://notes/existing.md",
    });
    await writeFile(join(tmpDir, "existing.md"), "# Existing\n");
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    };
    const store = {
      listDocuments: async () => ({ ok: true as const, value: [existing] }),
      getDocument: async () => ({ ok: true as const, value: existing }),
    };
    const req = new Request("http://localhost/api/capture", {
      method: "POST",
      body: JSON.stringify({
        collection: "notes",
        relPath: "existing.md",
        content: "# Existing\n",
        collisionPolicy: "open_existing",
      }),
    });

    const res = await routeApi(store as never, config, req, new URL(req.url));
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      openedExisting: boolean;
      docid: string;
      sync: { status: string };
    };
    expect(body.openedExisting).toBe(true);
    expect(body.docid).toBe("#abc123");
    expect(body.sync.status).toBe("completed");
  });

  test("creates folders inside a collection", async () => {
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

    const req = new Request("http://localhost/api/folders", {
      method: "POST",
      body: JSON.stringify({
        collection: "notes",
        parentPath: "projects",
        name: "research",
      }),
    });

    const res = await handleCreateFolder(ctxHolder, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folderPath: string };
    expect(body.folderPath).toBe("projects/research");
  });

  test("duplicates editable markdown files", async () => {
    const doc = createDoc(tmpDir);
    const sourcePath = join(tmpDir, "doc.md");
    await writeFile(sourcePath, "# Hello");

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
    const store = {
      ...createMockStore(doc),
      listDocuments: async () =>
        ({ ok: true as const, value: [doc] }) as StoreResult<DocumentRow[]>,
      getLinksForDoc: async () => ({ ok: true as const, value: [] }) as never,
      getBacklinksForDoc: async () =>
        ({ ok: true as const, value: [] }) as never,
    };
    const req = new Request("http://localhost/api/docs/abc123/duplicate", {
      method: "POST",
      body: JSON.stringify({ name: "copy.md" }),
    });

    const res = await handleDuplicateDoc(
      ctxHolder,
      store as never,
      "#abc123",
      req
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relPath: string };
    expect(body.relPath).toBe("copy.md");
  });

  test("moves editable markdown files to another folder", async () => {
    const doc = createDoc(tmpDir);
    const sourcePath = join(tmpDir, "doc.md");
    await writeFile(sourcePath, "# Hello");

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
    const store = {
      ...createMockStore(doc),
      getLinksForDoc: async () => ({ ok: true as const, value: [] }) as never,
      getBacklinksForDoc: async () =>
        ({ ok: true as const, value: [] }) as never,
    };
    const req = new Request("http://localhost/api/docs/abc123/move", {
      method: "POST",
      body: JSON.stringify({ folderPath: "projects" }),
    });

    const res = await handleMoveDoc(ctxHolder, store as never, "#abc123", req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relPath: string };
    expect(body.relPath).toBe("projects/doc.md");
  });
});
