import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const COLLECTION_COUNT = 20;
const DOCUMENTS_PER_COLLECTION = 25;
const CHUNKS_PER_DOCUMENT = 40;
const EMBED_MODEL = "status-perf-model";
const EMBED_FINGERPRINT = "status-perf-fingerprint";

describe("status aggregation performance", () => {
  let tempDir: string;
  let store: SqliteAdapter;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-status-perf-"));
    store = new SqliteAdapter();
    const openResult = await store.open(
      join(tempDir, "index.sqlite"),
      "unicode61"
    );
    expect(openResult.ok).toBe(true);

    const collections = Array.from(
      { length: COLLECTION_COUNT },
      (_, index) => ({
        name: `collection-${index}`,
        path: join(tempDir, `collection-${index}`),
        pattern: "**/*.md",
        include: [],
        exclude: [],
      })
    );
    const syncResult = await store.syncCollections(collections);
    expect(syncResult.ok).toBe(true);

    const db = store.getRawDb();
    const insertVector = db.prepare(`
      INSERT INTO content_vectors (
        mirror_hash, seq, model, embed_fingerprint, embedding, embedded_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);

    for (
      let collectionIndex = 0;
      collectionIndex < COLLECTION_COUNT;
      collectionIndex += 1
    ) {
      const collection = `collection-${collectionIndex}`;
      for (
        let documentIndex = 0;
        documentIndex < DOCUMENTS_PER_COLLECTION;
        documentIndex += 1
      ) {
        const mirrorHash = `mirror-${collectionIndex}-${documentIndex}`;
        const documentResult = await store.upsertDocument({
          collection,
          relPath: `doc-${documentIndex}.md`,
          sourceHash: `source-${collectionIndex}-${documentIndex}`,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: 100,
          sourceMtime: "2026-07-21T00:00:00Z",
          mirrorHash,
        });
        expect(documentResult.ok).toBe(true);
        await store.upsertContent(mirrorHash, "status fixture");
        await store.upsertChunks(
          mirrorHash,
          Array.from({ length: CHUNKS_PER_DOCUMENT }, (_, seq) => ({
            seq,
            pos: seq,
            text: `chunk ${seq}`,
            startLine: seq + 1,
            endLine: seq + 1,
          }))
        );
        for (let seq = 0; seq < CHUNKS_PER_DOCUMENT / 2; seq += 1) {
          insertVector.run(
            mirrorHash,
            seq,
            EMBED_MODEL,
            EMBED_FINGERPRINT,
            new Uint8Array([0, 0, 0, 0])
          );
        }
      }

      const sharedMirror = `mirror-${collectionIndex}-0`;
      const sharedResult = await store.upsertDocument({
        collection,
        relPath: "shared-copy.md",
        sourceHash: `shared-source-${collectionIndex}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: "2026-07-21T00:00:00Z",
        mirrorHash: sharedMirror,
      });
      expect(sharedResult.ok).toBe(true);
    }
  }, 30_000);

  afterAll(async () => {
    await store.close();
    await safeRm(tempDir);
  });

  test("uses set-based counts at production-like scale", async () => {
    const options = {
      embedModel: EMBED_MODEL,
      embedFingerprint: EMBED_FINGERPRINT,
    };
    await store.getStatus(options);
    const startedAt = performance.now();
    const result = await store.getStatus(options);
    const elapsedMs = performance.now() - startedAt;

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.totalChunks).toBe(20_000);
    expect(result.value.embeddingBacklog).toBe(10_000);
    expect(result.value.collections).toHaveLength(COLLECTION_COUNT);
    expect(result.value.collections[0]?.activeDocuments).toBe(26);
    expect(result.value.collections[0]?.totalChunks).toBe(1000);
    expect(result.value.collections[0]?.embeddedChunks).toBe(500);
    expect(elapsedMs).toBeLessThan(100);
  });
});
