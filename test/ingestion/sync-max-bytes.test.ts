/**
 * Integration test: maxBytes is enforced via stat before reading bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ConversionPipeline } from "../../src/converters/pipeline";
import type { WalkEntry, WalkerPort } from "../../src/ingestion/types";

import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("SyncService maxBytes pre-read enforcement", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-max-bytes-test-"));
    collectionDir = join(tmpDir, "docs");
    await Bun.$`mkdir -p ${collectionDir}`;
    dbPath = join(tmpDir, "test.db");

    adapter = new SqliteAdapter();
    const openResult = await adapter.open(dbPath, "porter");
    expect(openResult.ok).toBe(true);

    collection = {
      name: "docs",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    const syncResult = await adapter.syncCollections([collection]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("skips oversized file before conversion when walker entry size is stale", async () => {
    const relPath = "large.md";
    const absPath = join(collectionDir, relPath);
    await writeFile(absPath, `${"# large\n"}${"x".repeat(2_000)}`);

    const staleEntry: WalkEntry = {
      absPath,
      relPath,
      size: 64, // stale/incorrect size from walker
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    };

    const walker: WalkerPort = {
      walk: async () => ({
        entries: [staleEntry],
        skipped: [],
      }),
    };

    let convertCalls = 0;
    const pipeline = {
      convert: async () => {
        convertCalls += 1;
        throw new Error("convert should not run for oversized files");
      },
    };

    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      pipeline as unknown as ConversionPipeline
    );
    const result = await syncService.syncCollection(collection, adapter, {
      limits: { maxBytes: 128 },
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesAdded).toBe(0);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesErrored).toBe(0);
    expect(result.errors.some((e) => e.code === "TOO_LARGE")).toBe(true);
    expect(convertCalls).toBe(0);

    const docResult = await adapter.getDocument(collection.name, relPath);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) {
      return;
    }
    expect(docResult.value).toBeNull();
  });
});
