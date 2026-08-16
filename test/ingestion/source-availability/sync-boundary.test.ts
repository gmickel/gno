/**
 * Integration: processFile content boundary maps availability outcomes to skip/error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../../src/config/types";
import type { ConversionPipeline } from "../../../src/converters/pipeline";
import type {
  SourceAvailabilityMode,
  SourceContentReaderPort,
  SourceReadResult,
} from "../../../src/ingestion/source-availability";
import type { WalkEntry, WalkerPort } from "../../../src/ingestion/types";

import { SyncService } from "../../../src/ingestion/sync";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

function fixedReader(
  mode: SourceAvailabilityMode,
  result: SourceReadResult
): SourceContentReaderPort {
  return {
    mode,
    readAll: async () => result,
  };
}

describe("SyncService source-availability boundary", () => {
  let tmpDir: string;
  let collectionDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-src-avail-sync-"));
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
      sourceAvailability: "local",
    };
    const syncResult = await adapter.syncCollections([collection]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("CLOUD_PLACEHOLDER is skipped (not conversion error) and converter not called", async () => {
    const relPath = "cloud.md";
    const absPath = join(collectionDir, relPath);
    await writeFile(absPath, "# placeholder\n");

    const entry: WalkEntry = {
      absPath,
      relPath,
      size: 16,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    };
    const walker: WalkerPort = {
      walk: async () => ({ entries: [entry], skipped: [] }),
    };

    let convertCalls = 0;
    const pipeline = {
      convert: async () => {
        convertCalls += 1;
        throw new Error("convert must not run for cloud placeholders");
      },
    };

    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      pipeline as unknown as ConversionPipeline,
      () =>
        fixedReader("local", {
          ok: false,
          code: "CLOUD_PLACEHOLDER",
          message: "refused",
          errno: 11,
        })
    );

    const result = await syncService.syncCollection(collection, adapter, {
      sourceAvailability: "local",
    });

    expect(result.filesSkipped).toBe(1);
    expect(result.filesErrored).toBe(0);
    expect(result.filesAdded).toBe(0);
    expect(result.errors.some((e) => e.code === "CLOUD_PLACEHOLDER")).toBe(
      true
    );
    expect(convertCalls).toBe(0);

    const docResult = await adapter.getDocument(collection.name, relPath);
    expect(docResult.ok).toBe(true);
    if (!docResult.ok) return;
    expect(docResult.value).toBeNull();
  });

  test("unsupported platform fails closed as error (not silent any-fallback)", async () => {
    const relPath = "doc.md";
    const absPath = join(collectionDir, relPath);
    await writeFile(absPath, "# doc\n");

    const entry: WalkEntry = {
      absPath,
      relPath,
      size: 6,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    };
    const walker: WalkerPort = {
      walk: async () => ({ entries: [entry], skipped: [] }),
    };

    let convertCalls = 0;
    const pipeline = {
      convert: async () => {
        convertCalls += 1;
        throw new Error("convert must not run when local is unsupported");
      },
    };

    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      pipeline as unknown as ConversionPipeline,
      () =>
        fixedReader("local", {
          ok: false,
          code: "SOURCE_AVAILABILITY_UNSUPPORTED",
          message: "platform=linux",
        })
    );

    const result = await syncService.syncCollection(collection, adapter, {
      sourceAvailability: "local",
    });

    expect(result.filesErrored).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(
      result.errors.some((e) => e.code === "SOURCE_AVAILABILITY_UNSUPPORTED")
    ).toBe(true);
    expect(convertCalls).toBe(0);
  });

  test("short reads remain errors so watcher reconciliation can retry", async () => {
    const relPath = "truncated.md";
    const absPath = join(collectionDir, relPath);
    await writeFile(absPath, "# truncated\n");

    const entry: WalkEntry = {
      absPath,
      relPath,
      size: 64,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    };
    const walker: WalkerPort = {
      walk: async () => ({ entries: [entry], skipped: [] }),
    };

    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      undefined,
      () =>
        fixedReader("local", {
          ok: false,
          code: "IO_ERROR",
          message:
            "I/O error reading source file: short_read expected=64 read=12",
        })
    );

    const result = await syncService.syncCollection(collection, adapter, {
      sourceAvailability: "local",
    });

    expect(result.filesErrored).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.files).toContainEqual(
      expect.objectContaining({
        relPath,
        status: "error",
        errorCode: "IO_ERROR",
      })
    );
  });

  test("any mode still indexes when factory returns successful Bun-equivalent bytes", async () => {
    const relPath = "ok.md";
    const absPath = join(collectionDir, relPath);
    const body = "# ok\n";
    await writeFile(absPath, body);

    const entry: WalkEntry = {
      absPath,
      relPath,
      size: body.length,
      mtime: new Date().toISOString(),
      ctime: new Date().toISOString(),
    };
    const walker: WalkerPort = {
      walk: async () => ({ entries: [entry], skipped: [] }),
    };

    const anyCollection: Collection = {
      ...collection,
      sourceAvailability: "any",
    };

    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("any mode must preserve legacy reads");
      }
    );
    const result = await syncService.syncCollection(anyCollection, adapter);
    expect(result.filesErrored).toBe(0);
    expect(
      result.filesAdded + result.filesUpdated + result.filesUnchanged
    ).toBe(1);
  });
});
