/**
 * Integration tests for code-aware chunking during sync.
 *
 * @module test/ingestion/sync-code-chunking
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { SyncService } from "../../src/ingestion/sync";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

function buildTypeScriptFixture(): string {
  const imports = [
    'import { readFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    "",
  ].join("\n");

  const makeFunction = (name: string): string =>
    [
      `export function ${name}(): string {`,
      '  const lines = ["start",',
      ...Array.from({ length: 220 }, (_, i) => `    "line-${name}-${i}",`),
      "  ];",
      '  return lines.join("\\n");',
      "}",
      "",
    ].join("\n");

  return `${imports}${makeFunction("loadConfig")}${makeFunction("renderProfile")}${makeFunction("saveConfig")}`;
}

describe("SyncService code-aware chunking", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-code-chunking-"));
    collectionDir = join(tmpDir, "code");
    await Bun.$`mkdir -p ${collectionDir}`;
    dbPath = join(tmpDir, "test.db");

    adapter = new SqliteAdapter();
    const openResult = await adapter.open(dbPath, "porter");
    expect(openResult.ok).toBe(true);

    collection = {
      name: "code",
      path: collectionDir,
      pattern: "**/*",
      include: [".ts"],
      exclude: [],
    };

    const syncCollectionsResult = await adapter.syncCollections([collection]);
    expect(syncCollectionsResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("stores structural chunks for supported code files and exposes them to search", async () => {
    await writeFile(
      join(collectionDir, "example.ts"),
      buildTypeScriptFixture()
    );

    const syncService = new SyncService();
    const syncResult = await syncService.syncCollection(collection, adapter);
    expect(syncResult.filesProcessed).toBe(1);
    expect(syncResult.filesErrored).toBe(0);

    const docResult = await adapter.getDocument("code", "example.ts");
    expect(docResult.ok).toBe(true);
    if (!docResult.ok || !docResult.value?.mirrorHash) {
      return;
    }

    const chunksResult = await adapter.getChunks(docResult.value.mirrorHash);
    expect(chunksResult.ok).toBe(true);
    if (!chunksResult.ok) {
      return;
    }

    expect(chunksResult.value.length).toBeGreaterThan(1);
    expect(
      chunksResult.value.some((chunk) =>
        chunk.text.startsWith("export function renderProfile")
      )
    ).toBe(true);

    const searchResult = await searchBm25(adapter, "renderProfile", {
      collection: "code",
      lineNumbers: true,
      intent: "renderProfile function",
    });

    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) {
      return;
    }

    const first = searchResult.value.results[0];
    expect(first).toBeDefined();
    expect(first?.snippet.startsWith("export function renderProfile")).toBe(
      true
    );
    expect(first?.snippetRange?.startLine).toBeGreaterThan(200);
  });
});
