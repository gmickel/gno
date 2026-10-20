/**
 * gno_search / gno_vsearch / gno_query `collections` allowlist (fn-222).
 * Validation runs before any model is resolved, so the error cases need no
 * model; the search success path runs against a real index.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp: Bun has no temp-directory API.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path for tmpdir/join: no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/server";

import { handleQuery } from "../../src/mcp/tools/query";
import { handleSearch } from "../../src/mcp/tools/search";
import { handleVsearch } from "../../src/mcp/tools/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const NAMES = ["alpha", "beta", "loud"];
let tmpDir: string;
let store: SqliteAdapter;
let collections: Collection[];

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "gno-mcp-collections-"));
  store = new SqliteAdapter();
  expect((await store.open(join(tmpDir, "test.db"), "porter")).ok).toBe(true);
  collections = NAMES.map((name) => ({
    name,
    path: join(tmpDir, name),
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  expect((await store.syncCollections(collections)).ok).toBe(true);
  const docs: [collection: string, relPath: string, text: string][] = [
    ...Array.from({ length: 4 }, (_, i): [string, string, string] => [
      "loud",
      `l${i}.md`,
      "needle needle needle",
    ]),
    ["alpha", "a.md", "needle in a haystack of words"],
    ["beta", "b.md", "one needle among other words"],
  ];
  for (const [index, [collection, relPath, text]] of docs.entries()) {
    const hash = `${index.toString(16).padStart(8, "0")}-hash`;
    const inserted = await store.upsertDocument({
      collection,
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: relPath,
      mirrorHash: hash,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await store.upsertContent(hash, text)).ok).toBe(true);
    expect(
      (
        await store.upsertChunks(hash, [
          { seq: 0, pos: 0, text, startLine: 1, endLine: 1, language: "en" },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(hash)).ok).toBe(true);
  }
});

afterAll(async () => {
  await store.close();
  await safeRm(tmpDir);
});

const ctx = (): ToolContext => ({
  indexName: "default",
  store,
  config: { version: "1.0", ftsTokenizer: "porter", collections, contexts: [] },
  collections,
  actualConfigPath: join(tmpDir, "config.yml"),
  toolMutex: { acquire: async () => () => {} } as ToolContext["toolMutex"],
  jobManager: {} as ToolContext["jobManager"],
  serverInstanceId: "test",
  writeLockPath: join(tmpDir, ".lock"),
  enableWrite: false,
  isShuttingDown: () => false,
});

type Structured = {
  error?: string;
  message?: string;
  results?: { uri: string }[];
  meta?: { collections?: string[]; collection?: string };
};
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Structured;

const HANDLERS = {
  gno_search: handleSearch,
  gno_vsearch: handleVsearch,
  gno_query: handleQuery,
} as const;

describe("MCP collections allowlist", () => {
  test("gno_search serves only listed collections and echoes the list", async () => {
    const result = await handleSearch(
      { query: "needle", limit: 2, collections: ["Beta", "alpha"] },
      ctx()
    );
    expect(result.isError).toBeFalsy();
    const body = structured(result);
    expect(body.results?.map(({ uri }) => uri).toSorted()).toEqual([
      "gno://alpha/a.md",
      "gno://beta/b.md",
    ]);
    expect(body.meta?.collections).toEqual(["alpha", "beta"]);
    expect(body.meta?.collection).toBeUndefined();
  });

  for (const [tool, handle] of Object.entries(HANDLERS)) {
    test(`${tool} refuses collection with collections`, async () => {
      const result = await handle(
        { query: "needle", collection: "alpha", collections: ["alpha"] },
        ctx()
      );
      expect(result.isError).toBe(true);
      expect(structured(result)).toEqual({
        error: "VALIDATION",
        message: "Pass either collection or collections, not both",
      });
    });

    test(`${tool} refuses an empty or oversized list`, async () => {
      for (const list of [[], Array.from({ length: 257 }, (_, i) => `c${i}`)]) {
        const result = await handle(
          { query: "needle", collections: list },
          ctx()
        );
        expect(result.isError).toBe(true);
        expect(structured(result).error).toBe("VALIDATION");
      }
    });

    test(`${tool} names every unknown collection`, async () => {
      const result = await handle(
        { query: "needle", collections: ["alpha", "nope", "gone"] },
        ctx()
      );
      expect(result.isError).toBe(true);
      expect(structured(result).message).toBe(
        "Collections not found: gone, nope"
      );
    });
  }
});
