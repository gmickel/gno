/**
 * Regression tests for unchanged non-retryable conversion failures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ConversionPipeline } from "../../src/converters/pipeline";

import { INGEST_VERSION, SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("SyncService conversion failure retries", () => {
  let adapter: SqliteAdapter;
  let collection: Collection;
  let collectionDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-conversion-error-test-"));
    collectionDir = join(tmpDir, "docs");
    await Bun.$`mkdir -p ${collectionDir}`;

    adapter = new SqliteAdapter();
    const openResult = await adapter.open(join(tmpDir, "test.db"), "porter");
    expect(openResult.ok).toBe(true);

    collection = {
      name: "docs",
      path: collectionDir,
      pattern: "**/*.pdf",
      include: [".pdf"],
      exclude: [],
    };
    const syncResult = await adapter.syncCollections([collection]);
    expect(syncResult.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("does not retry an unchanged corrupt file", async () => {
    const relPath = "truncated.pdf";
    await writeFile(join(collectionDir, relPath), "%PDF-1.7\ntruncated");

    let convertCalls = 0;
    const pipeline = {
      convert: async () => {
        convertCalls += 1;
        return {
          ok: false as const,
          error: {
            code: "CORRUPT" as const,
            message: "Invalid or incomplete PDF structure",
            retryable: false,
            fatal: false,
            converterId: "test",
            sourcePath: join(collectionDir, relPath),
            mime: "application/pdf",
            ext: ".pdf",
          },
        };
      },
    };
    const syncService = new SyncService(
      undefined,
      undefined,
      undefined,
      pipeline as unknown as ConversionPipeline
    );

    const first = await syncService.syncCollection(collection, adapter);
    const second = await syncService.syncCollection(collection, adapter);

    expect(first.filesErrored).toBe(1);
    expect(second.filesErrored).toBe(0);
    expect(second.filesUnchanged).toBe(1);
    expect(convertCalls).toBe(1);

    const docResult = await adapter.getDocument(collection.name, relPath);
    expect(docResult.ok).toBe(true);
    if (docResult.ok) {
      expect(docResult.value?.lastErrorCode).toBe("CORRUPT");
      expect(docResult.value?.ingestVersion).toBe(INGEST_VERSION);
    }
  });
});
