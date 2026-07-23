/**
 * Regression tests for unchanged non-retryable conversion failures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ConversionPipeline } from "../../src/converters/pipeline";

import { decodeDocumentChangeCursor } from "../../src/core/change-journal";
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

  test("never journals initial or repeated never-successful conversion failures", async () => {
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
    const afterFirst = await adapter.listDocumentChanges();
    expect(afterFirst.ok && afterFirst.value.changes).toEqual([]);

    await writeFile(join(collectionDir, relPath), "%PDF-1.7\nstill truncated");
    const second = await syncService.syncCollection(collection, adapter);
    const afterSecond = await adapter.listDocumentChanges();
    expect(afterSecond.ok && afterSecond.value.changes).toEqual([]);
    const third = await syncService.syncCollection(collection, adapter);

    expect(first.filesErrored).toBe(1);
    expect(second.filesErrored).toBe(1);
    expect(third.filesErrored).toBe(0);
    expect(third.filesUnchanged).toBe(1);
    expect(convertCalls).toBe(2);
    const afterThird = await adapter.listDocumentChanges();
    expect(afterThird.ok && afterThird.value.changes).toEqual([]);

    const docResult = await adapter.getDocument(collection.name, relPath);
    expect(docResult.ok).toBe(true);
    if (docResult.ok) {
      expect(docResult.value?.lastErrorCode).toBe("CORRUPT");
      expect(docResult.value?.ingestVersion).toBe(INGEST_VERSION);
    }
  });

  test("journals evidence disappearance when a changed document stops converting", async () => {
    collection = {
      ...collection,
      pattern: "**/*.md",
      include: [".md"],
      exclude: [],
    };
    expect((await adapter.syncCollections([collection])).ok).toBe(true);
    const relPath = "decision.md";
    const path = join(collectionDir, relPath);
    await writeFile(path, "# Before\n\nSee [[Target]].\n");
    const initial = await new SyncService().syncCollection(collection, adapter);
    expect(initial.filesAdded).toBe(1);
    const before = await adapter.getDocument(collection.name, relPath);
    expect(before.ok && before.value?.mirrorHash).toBeTruthy();
    if (!before.ok || !before.value?.mirrorHash) return;
    const beforeJournal = await adapter.listDocumentChanges({ limit: 1 });
    expect(beforeJournal.ok).toBe(true);
    if (!beforeJournal.ok) return;
    const registrationId = `capsule-${"a".repeat(40)}`;
    expect(
      (
        await adapter.upsertSavedCapsuleRegistration({
          registrationId,
          filePath: join(collectionDir, "decision.capsule.json"),
          fileHash: "b".repeat(64),
          capsuleId: "c".repeat(64),
          indexName: "default",
          question: null,
          label: null,
          notificationPreference: "none",
          registeredAtMs: 1,
          updatedAtMs: 1,
          lastAttemptedSequence: decodeDocumentChangeCursor(
            beforeJournal.value.latestCursor
          ),
          evidence: [
            {
              evidenceId: "d".repeat(64),
              canonicalUri: before.value.uri,
              collection: before.value.collection,
              sourceHash: before.value.sourceHash,
              mirrorHash: before.value.mirrorHash,
              passageHash: "e".repeat(64),
            },
          ],
        })
      ).ok
    ).toBe(true);

    await writeFile(path, "# Changed but corrupt\n");
    const failingPipeline = {
      convert: async () => ({
        ok: false as const,
        error: {
          code: "CORRUPT" as const,
          message: "Invalid document structure",
          retryable: false,
          fatal: false,
          converterId: "test",
          sourcePath: path,
          mime: "text/markdown",
          ext: ".md",
        },
      }),
    };
    const failed = await new SyncService(
      undefined,
      undefined,
      undefined,
      failingPipeline as unknown as ConversionPipeline
    ).syncCollection(collection, adapter);
    expect(failed.filesErrored).toBe(1);

    const after = await adapter.getDocument(collection.name, relPath);
    expect(after.ok && after.value).toMatchObject({
      mirrorHash: null,
      lastErrorCode: "CORRUPT",
    });
    const journal = await adapter.listDocumentChanges();
    expect(journal.ok).toBe(true);
    if (!journal.ok) return;
    expect(journal.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "update",
    ]);
    expect(journal.value.changes[1]).toMatchObject({
      oldMirrorHash: before.value.mirrorHash,
      newMirrorHash: null,
      structureDelta: {
        headings: { added: [], removed: ["# Before"] },
        links: { added: [], removed: ["wiki:target"] },
      },
    });
    const affected = await adapter.listSavedCapsuleIdsAffectedByChanges(
      decodeDocumentChangeCursor(beforeJournal.value.latestCursor),
      decodeDocumentChangeCursor(journal.value.latestCursor),
      100
    );
    expect(affected.ok && affected.value.registrationIds).toEqual([
      registrationId,
    ]);
  });
});
