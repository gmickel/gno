import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";
import type { DocumentRow } from "../../src/store/types";

import {
  handleRenameDoc,
  handleRevealDoc,
  handleTrashDoc,
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

function createMockStore(doc: DocumentRow) {
  return {
    getDocumentByDocid(id: string) {
      return Promise.resolve({
        ok: true as const,
        value: id === doc.docid ? doc : null,
      });
    },
    markInactive() {
      return Promise.resolve({ ok: true as const, value: undefined });
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

    const res = await handleTrashDoc(ctxHolder, store as never, "#abc123", {
      trashFilePath: async () => undefined,
      syncCollection: async () =>
        ({ ok: true as const, value: undefined }) as never,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; note: string };
    expect(body.success).toBe(true);
    expect(body.note).toContain("Moved to Trash");
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
    const res = await handleRevealDoc(ctxHolder, store as never, "#abc123", {
      revealFilePath: async (path) => {
        revealedPath = path;
      },
    });

    expect(res.status).toBe(200);
    expect(revealedPath).toBe(sourcePath);
  });
});
