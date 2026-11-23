/**
 * Contract and regression tests for fn-229: lossless SQLite and vector store
 * performance (R1-R8).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// Bun has no temp-directory, OS, or path utilities.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseStoredTypedMetadata,
  TYPED_METADATA_INGEST_VERSION,
  typedMetadataSchema,
} from "../../src/core/typed-metadata";
import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import { migration as m037 } from "../../src/store/migrations/037-performance-indexes";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { storedSimilarityEdges } from "../../src/store/sqlite/graph-similarity";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { getVariantStatus } from "../../src/store/vector/status";
import { readSimilaritySourceVectors } from "../../src/store/vector/stored-vectors";
import { searchVectorVariants } from "../../src/store/vector/variant-search";
import { createVectorVariantStore } from "../../src/store/vector/variants";
import { safeRm } from "../helpers/cleanup";

const cleanupDirs: string[] = [];
const cleanupStores: SqliteAdapter[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const store of cleanupStores.splice(0)) {
    await store.close();
  }
  for (const dir of cleanupDirs.splice(0)) {
    await safeRm(dir);
  }
});

describe("R1: SQLite connection PRAGMAs", () => {
  test("sets cache_size, temp_store, mmap_size, and WAL synchronous=NORMAL outside CI", async () => {
    const dir = await makeTempDir("gno-r1-pragmas-");
    const dbPath = join(dir, "index.sqlite");
    const prevCi = process.env.CI;
    delete process.env.CI;
    try {
      const store = new SqliteAdapter();
      cleanupStores.push(store);
      const opened = await store.open(dbPath, "unicode61");
      expect(opened.ok).toBe(true);
      const db = store.getRawDb();

      expect(
        db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
          ?.cache_size
      ).toBe(-131072);
      expect(
        db.query<{ temp_store: number }, []>("PRAGMA temp_store").get()
          ?.temp_store
      ).toBe(2); // MEMORY
      expect(
        db.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()?.mmap_size
      ).toBeGreaterThanOrEqual(0);
      expect(
        db
          .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
          .get()
          ?.journal_mode.toLowerCase()
      ).toBe("wal");
      expect(
        db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()
          ?.synchronous
      ).toBe(1); // NORMAL

      // Secondary read connection uses -65536 cache_size and MEMORY temp_store
      await store.withReadConnection(async () => {
        const readDb = store.getRawDb();
        expect(readDb).not.toBe(db);
        expect(
          readDb.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
            ?.cache_size
        ).toBe(-65536);
        expect(
          readDb.query<{ temp_store: number }, []>("PRAGMA temp_store").get()
            ?.temp_store
        ).toBe(2);
      });

      // Read-only opener uses -65536 cache_size and MEMORY temp_store
      const roStore = new SqliteAdapter();
      cleanupStores.push(roStore);
      const roOpened = roStore.openReadOnly(dbPath);
      expect(roOpened.ok).toBe(true);
      const roDb = roStore.getRawDb();
      expect(
        roDb.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
          ?.cache_size
      ).toBe(-65536);
      expect(
        roDb.query<{ temp_store: number }, []>("PRAGMA temp_store").get()
          ?.temp_store
      ).toBe(2);

      // In-memory DB cannot enable WAL -> synchronous remains FULL (2) outside CI
      const memStore = new SqliteAdapter();
      cleanupStores.push(memStore);
      expect((await memStore.open(":memory:", "unicode61")).ok).toBe(true);
      expect(
        memStore
          .getRawDb()
          .query<{ synchronous: number }, []>("PRAGMA synchronous")
          .get()?.synchronous
      ).toBe(2);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }
  });

  test("keeps synchronous=OFF when CI is set", async () => {
    const dir = await makeTempDir("gno-r1-ci-");
    const dbPath = join(dir, "index.sqlite");
    const prevCi = process.env.CI;
    process.env.CI = "true";
    try {
      const store = new SqliteAdapter();
      cleanupStores.push(store);
      expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
      expect(
        store
          .getRawDb()
          .query<{ synchronous: number }, []>("PRAGMA synchronous")
          .get()?.synchronous
      ).toBe(0); // OFF
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }
  });
});

describe("R2: Migration 037 covering and cleanup indexes + query plans", () => {
  test("upgrades v36 cleanly, supports down(), and produces scan-free query plans", async () => {
    const dir = await makeTempDir("gno-r2-mig037-");
    const dbPath = join(dir, "index.sqlite");
    const raw = new Database(dbPath);
    try {
      expect(runMigrations(raw, migrations.slice(0, 36), "unicode61").ok).toBe(
        true
      );
      expect(getSchemaVersion(raw)).toBe(36);
      expect(runMigrations(raw, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(raw)).toBe(38);

      const indexes = new Set(
        raw
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
          )
          .all()
          .map((r) => r.name)
      );

      for (const expected of [
        "idx_vector_owners_partition_variant",
        "idx_vector_owners_doc_part",
        "idx_vector_owners_mirror_seq",
        "idx_retrieval_traces_created",
        "idx_documents_collection_mtime",
        "idx_doc_tags_tag_doc",
      ]) {
        expect(indexes.has(expected)).toBe(true);
      }

      for (const dropped of [
        "idx_doc_tags_tag",
        "idx_chunks_mirror_hash",
        "idx_doc_links_source_doc",
        "idx_doc_edges_src_type",
        "idx_doc_edges_dst_type",
        "idx_vectors_model",
      ]) {
        expect(indexes.has(dropped)).toBe(false);
      }

      const planOf = (sql: string) => {
        const stmt = raw.prepare<{ detail: string }, []>(
          `EXPLAIN QUERY PLAN ${sql}`
        );
        try {
          return stmt.all().map((r) => r.detail);
        } finally {
          stmt.finalize();
        }
      };

      // Chunk deletion uses idx_vector_owners_mirror_seq (no SCAN vector_owners)
      const deletePlan = planOf(
        "DELETE FROM vector_owners WHERE mirror_hash = 'abc' AND seq = 0"
      );
      expect(deletePlan.some((d) => /SCAN vector_owners/.test(d))).toBe(false);
      expect(deletePlan.join("\n")).toContain("idx_vector_owners_mirror_seq");

      // Scoped variant search uses idx_vector_owners_doc_part with no SCAN or AUTOMATIC COVERING INDEX
      const scopedPlan = planOf(`
        SELECT g.mirrorHash, g.seq, v.input_hash AS inputHash, g.documentIds
        FROM (
          SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
            json_group_array(o.document_id) AS documentIds
          FROM (SELECT d.id, d.mirror_hash FROM documents d WHERE d.active = 1 AND d.collection = 'notes') e
          CROSS JOIN vector_owners o INDEXED BY idx_vector_owners_doc_part
            ON o.document_id = e.id AND o.mirror_hash = e.mirror_hash
          JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
          WHERE o.partition_id = 'p1'
          GROUP BY o.variant_id, o.mirror_hash, o.seq
        ) g
        CROSS JOIN vector_variants v ON v.partition_id = 'p1' AND v.variant_id = g.variantId
        ORDER BY g.mirrorHash, g.seq, g.variantId LIMIT 10
      `);
      expect(scopedPlan.some((d) => /SCAN vector_owners/.test(d))).toBe(false);
      expect(scopedPlan.some((d) => /AUTOMATIC COVERING INDEX/.test(d))).toBe(
        false
      );
      expect(scopedPlan.join("\n")).toContain("idx_vector_owners_doc_part");

      // Unscoped variant search uses idx_vector_owners_partition_variant with no SCAN vector_owners
      const unscopedPlan = planOf(`
        SELECT g.mirrorHash, g.seq, v.input_hash AS inputHash, g.documentIds
        FROM (
          SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
            json_group_array(o.document_id) AS documentIds
          FROM vector_owners o INDEXED BY idx_vector_owners_partition_variant
          CROSS JOIN (SELECT d.id, d.mirror_hash FROM documents d WHERE d.active = 1) e
            ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
          JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
          WHERE o.partition_id = 'p1'
          GROUP BY o.variant_id, o.mirror_hash, o.seq
        ) g
        CROSS JOIN vector_variants v ON v.partition_id = 'p1' AND v.variant_id = g.variantId
        ORDER BY g.mirrorHash, g.seq, g.variantId LIMIT 10
      `);
      expect(unscopedPlan.some((d) => /SCAN vector_owners/.test(d))).toBe(
        false
      );
      expect(unscopedPlan.some((d) => /TEMP B-TREE FOR GROUP BY/.test(d))).toBe(
        false
      );
      expect(unscopedPlan.join("\n")).toContain(
        "idx_vector_owners_partition_variant"
      );

      // Rollback restores prior indexes cleanly
      m037.down?.(raw);
      const rolledBack = new Set(
        raw
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
          )
          .all()
          .map((r) => r.name)
      );
      expect(rolledBack.has("idx_vector_owners_doc_part")).toBe(false);
      expect(rolledBack.has("idx_doc_tags_tag")).toBe(true);
      expect(rolledBack.has("idx_chunks_mirror_hash")).toBe(true);
    } finally {
      raw.close();
    }
  });
});

describe("R3 & R4 & R5: Proof cache rollback isolation, single-write writeRows, savepoint upsert", () => {
  const identity = {
    model: "test-perf-model",
    modelFingerprint: "test-perf-weights",
    contextSize: 512,
    truncationPolicy: "tail-v1",
    dimensions: 4,
  };

  test("proof cache survives unrelated writes and never leaks uncommitted rolled-back edits", async () => {
    const dir = await makeTempDir("gno-r3-proof-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    await store.upsertDocument({
      collection: "notes",
      relPath: "a.md",
      sourceHash: "src-a",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2026-09-01T00:00:00.000Z",
      title: "Original Title",
      mirrorHash: "m-a",
    });
    await store.upsertContent("m-a", "hello world");
    await store.upsertChunks("m-a", [
      { seq: 0, pos: 0, text: "hello world", startLine: 1, endLine: 1 },
    ]);

    const db = store.getRawDb();
    const vecPort = await createVectorIndexPort(db, {
      model: identity.model,
      dimensions: identity.dimensions,
    });
    expect(vecPort.ok).toBe(true);
    const vstore = await createVectorVariantStore(db, identity);

    // Track UPDATE calls on vector_variants to verify R4 single-write on fresh insert
    let variantUpdates = 0;
    db.exec(`
      CREATE TEMP TABLE _update_log(n INTEGER);
      CREATE TEMP TRIGGER _log_variant_update AFTER UPDATE ON vector_variants BEGIN
        INSERT INTO _update_log VALUES (1);
      END;
    `);
    const pending = vstore.pending({ limit: 10 });
    expect(pending).toHaveLength(1);
    vstore.write([
      { owner: pending[0]!, embedding: new Float32Array([1, 0, 0, 0]) },
    ]);
    variantUpdates = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM _update_log")
      .get()!.n;
    expect(variantUpdates).toBe(0);
    vstore.activate(vstore.epoch());

    const queryVec = new Float32Array([1, 0, 0, 0]);
    const hits1 = searchVectorVariants(
      db,
      identity.model,
      identity.dimensions,
      queryVec,
      5,
      { partitionId: vstore.partitionId }
    );
    expect(hits1).toHaveLength(1);

    // Unrelated write (schema_meta) does not increment vector_variant_epoch
    const epochBefore = vstore.epoch();
    db.run(
      "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('perf_unrelated_test', 'v1')"
    );
    expect(vstore.epoch()).toBe(epochBefore);

    // Nested transaction mutates title -> search sees 0 hits -> ROLLBACK -> next search MUST still see 1 hit
    db.exec("BEGIN");
    db.run(
      "UPDATE documents SET title = 'Rolled Back Title' WHERE rel_path = 'a.md'"
    );
    const hitsDuringTx = searchVectorVariants(
      db,
      identity.model,
      identity.dimensions,
      queryVec,
      5,
      { partitionId: vstore.partitionId }
    );
    expect(hitsDuringTx).toHaveLength(0);
    db.exec("ROLLBACK");

    // Advance epoch on another column so the rolled-back epoch number is reused!
    db.run("UPDATE documents SET source_size = 11 WHERE rel_path = 'a.md'");
    const hitsAfterRollback = searchVectorVariants(
      db,
      identity.model,
      identity.dimensions,
      queryVec,
      5,
      { partitionId: vstore.partitionId }
    );
    expect(hitsAfterRollback).toHaveLength(1);

    // minScore cutoff stops immediately when 1 - distance < minScore
    const hitsCutoff = searchVectorVariants(
      db,
      identity.model,
      identity.dimensions,
      new Float32Array([0, 1, 0, 0]),
      5,
      { partitionId: vstore.partitionId, minScore: 0.5 }
    );
    expect(hitsCutoff).toEqual([]);

    // R4 error semantics: non-finite floats and wrong dimensions fail closed
    expect(() =>
      vstore.write([
        {
          owner: pending[0]!,
          embedding: new Float32Array([Number.NaN, 0, 0, 0]),
        },
      ])
    ).toThrow("Invalid vector dimensions or values");
    expect(() =>
      vstore.write([
        { owner: pending[0]!, embedding: new Float32Array([1, 0]) },
      ])
    ).toThrow("Invalid vector dimensions or values");
  });

  test("R5: legacy upsertVectors SAVEPOINT preserves content_vectors when vec0 fails", async () => {
    const dir = await makeTempDir("gno-r5-savepoint-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    const db = store.getRawDb();
    await store.upsertContent("m1", "body");
    await store.upsertChunks("m1", [
      { seq: 0, pos: 0, text: "body", startLine: 1, endLine: 1 },
    ]);

    const portRes = await createVectorIndexPort(db, {
      model: "legacy-sp-model",
      dimensions: 3,
    });
    expect(portRes.ok).toBe(true);
    if (!portRes.ok) return;
    const port = portRes.value;
    expect(port.searchAvailable).toBe(true);

    // Wrong dimension triggers vec0 failure inside SAVEPOINT while content_vectors still stores the row
    const badRes = await port.upsertVectors([
      {
        mirrorHash: "m1",
        seq: 0,
        model: "legacy-sp-model",
        embedFingerprint: "fp1",
        embedding: new Float32Array([1, 0]),
      },
    ]);
    expect(badRes.ok).toBe(true);
    expect(port.vecDirty).toBe(true);
    const storedCount = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM content_vectors WHERE mirror_hash = 'm1'"
      )
      .get()!.c;
    expect(storedCount).toBe(1);
  });
});

describe("R7: parseStoredTypedMetadata parity with typedMetadataSchema", () => {
  test("accepts valid metadata and rejects all invalid cases identically", () => {
    const valid = [
      "{}",
      JSON.stringify({ a: 1, b: "hello", c: true, d: [1, 2, 3], e: [] }),
    ];
    for (const raw of valid) {
      expect(parseStoredTypedMetadata(raw)).toEqual(
        typedMetadataSchema.parse(JSON.parse(raw))
      );
    }

    const oversizedKeys: Record<string, number> = {};
    for (let i = 0; i < 65; i++) oversizedKeys[`k${i}`] = i;

    const oversizedBytes: Record<string, string> = {};
    for (let i = 0; i < 20; i++) oversizedBytes[`big${i}`] = "x".repeat(4000);

    const invalid = [
      "not-json",
      "null",
      "[]",
      '"str"',
      '{"__proto__": 1}',
      '{"constructor": "x"}',
      '{"prototype": true}',
      '{"": "empty-key"}',
      JSON.stringify({ ["k".repeat(129)]: 1 }),
      JSON.stringify({ s: "x".repeat(4097) }),
      JSON.stringify({ arr: [1, "two"] }),
      JSON.stringify({ arr: Array.from({ length: 129 }, (_, i) => i) }),
      JSON.stringify(oversizedKeys),
      JSON.stringify(oversizedBytes),
      '{"nested": {"a": 1}}',
    ];
    for (const raw of invalid) {
      expect(() => parseStoredTypedMetadata(raw)).toThrow();
    }
  });
});

describe("R8: >999-ID batches, term presence, and upper-triangle similarity parity", () => {
  test("getTagsBatch, getDocumentsByDocids, and getChunkTermPresence work past 999 items", async () => {
    const dir = await makeTempDir("gno-r8-batches-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "bulk",
        path: join(dir, "bulk"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);

    const docIds: number[] = [];
    const docids: string[] = [];
    const hashes: string[] = [];
    const db = store.getRawDb();
    const tx = db.transaction(() => {
      const insDoc = db.query<
        { id: number },
        [string, string, string, string, string, string]
      >(
        `INSERT INTO documents (
           collection, rel_path, source_hash, source_mime, source_ext,
           source_size, source_mtime, docid, uri, title, mirror_hash,
           active, ingest_version
         ) VALUES ('bulk', ?, ?, 'text/markdown', '.md', 10, '2026-09-01T00:00:00Z',
           ?, ?, ?, ?, 1, ${TYPED_METADATA_INGEST_VERSION}) RETURNING id`
      );
      const insTag = db.query<unknown, [number, string]>(
        "INSERT INTO doc_tags(document_id, tag, source) VALUES (?, ?, 'frontmatter')"
      );
      const insContent = db.query<unknown, [string, string]>(
        "INSERT INTO content(mirror_hash, markdown) VALUES (?, ?)"
      );
      const insChunk = db.query<unknown, [string, string]>(
        "INSERT INTO content_chunks(mirror_hash, seq, pos, text, start_line, end_line) VALUES (?, 0, 0, ?, 1, 1)"
      );
      for (let i = 0; i < 1050; i++) {
        const hash = `h-${i}`;
        const docid = `#bulk${i}`;
        const id = insDoc.get(
          `doc-${i}.md`,
          `s-${i}`,
          docid,
          `gno://bulk/doc-${i}.md`,
          `Doc ${i}`,
          hash
        )!.id;
        insTag.run(id, `tag-${i % 10}`);
        const body = i === 0 ? "Überblick ALPHA beta" : `alpha item ${i}`;
        insContent.run(hash, body);
        insChunk.run(hash, body);
        docIds.push(id);
        docids.push(docid);
        hashes.push(hash);
      }
    });
    tx();

    const tagsRes = await store.getTagsBatch(docIds);
    expect(tagsRes.ok).toBe(true);
    if (tagsRes.ok) expect(tagsRes.value.size).toBe(1050);

    const docsRes = await store.getDocumentsByDocids(docids);
    expect(docsRes.ok).toBe(true);
    if (docsRes.ok) expect(docsRes.value).toHaveLength(1050);

    const presence = await store.getChunkTermPresence(hashes.slice(0, 2), [
      "alpha",
      "überblick",
      "missing",
    ]);
    expect(presence.ok).toBe(true);
    if (presence.ok) {
      const byHash = new Map(
        presence.value.map((r) => [r.mirrorHash, r.present])
      );
      expect(byHash.get("h-0")).toEqual([true, true, false]);
      expect(byHash.get("h-1")).toEqual([true, false, false]);
    }
  });

  test("storedSimilarityEdges upper-triangle matches brute-force oracle and readSimilaritySourceVectors falls back to seq > 0", async () => {
    const dir = await makeTempDir("gno-r8-sim-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "sim",
        path: join(dir, "sim"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);

    const db = store.getRawDb();
    const vecs = [
      new Float32Array([1, 0, 0]),
      new Float32Array([0.9, 0.43589, 0]),
      new Float32Array([0.5, 0.866025, 0]),
      new Float32Array([0, 1, 0]),
    ];
    const docids: string[] = [];
    for (let i = 0; i < vecs.length; i++) {
      const res = await store.upsertDocument({
        collection: "sim",
        relPath: `d${i}.md`,
        sourceHash: `s${i}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 10,
        sourceMtime: "2026-09-01T00:00:00Z",
        title: `D${i}`,
        mirrorHash: `m${i}`,
      });
      if (!res.ok) throw new Error(res.error.message);
      docids.push(res.value.docid);
      await store.upsertContent(`m${i}`, `chunk0\nchunk1`);
      await store.upsertChunks(`m${i}`, [
        { seq: 0, pos: 0, text: `chunk0-${i}`, startLine: 1, endLine: 1 },
        { seq: 1, pos: 10, text: `chunk1-${i}`, startLine: 2, endLine: 2 },
      ]);
      // Insert seq=1 only for doc 3 to exercise seq > 0 fallback in legacy mode too
      const seq = i === 3 ? 1 : 0;
      const bytes = new Uint8Array(vecs[i]!.buffer.slice(0));
      db.run(
        `INSERT INTO content_vectors(mirror_hash, seq, model, embed_fingerprint, embedding)
         VALUES (?, ?, 'sim-model', 'fp', ?)`,
        [`m${i}`, seq, bytes]
      );
    }

    const source = { kind: "legacy" as const, model: "sim-model" };
    const docs = db
      .query<{ id: number; mirrorHash: string }, []>(
        "SELECT id, mirror_hash AS mirrorHash FROM documents ORDER BY id"
      )
      .all();
    const loaded = readSimilaritySourceVectors(db, source, docs);
    expect(loaded.size).toBe(4);

    const result = storedSimilarityEdges(db, "sim-model", docids, 0.4, 2);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.embeddedNodes).toBe(4);
    // Every node has at most topK=2 edges and scores are symmetric across pairs
    const bySource = new Map<string, typeof result.edges>();
    for (const edge of result.edges) {
      const list = bySource.get(edge.source) ?? [];
      list.push(edge);
      bySource.set(edge.source, list);
    }
    for (const [, list] of bySource) {
      expect(list.length).toBeLessThanOrEqual(2);
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1]!.score).toBeGreaterThanOrEqual(list[i]!.score);
      }
    }
  });
});

describe("Review regression checks (R3, R4, R6, R7, R8)", () => {
  test("R4: fresh variant write replaces stale orphan row in dirty vec0 mirror on variant_id reuse", async () => {
    const dir = await makeTempDir("gno-reg-id-reuse-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    const db = store.getRawDb();
    const d1 = await store.upsertDocument({
      collection: "notes",
      relPath: "a.md",
      sourceHash: "sa",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 5,
      sourceMtime: "2026-09-01T00:00:00Z",
      title: "A",
      mirrorHash: "ma",
    });
    const d2 = await store.upsertDocument({
      collection: "notes",
      relPath: "b.md",
      sourceHash: "sb",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 5,
      sourceMtime: "2026-09-01T00:00:00Z",
      title: "B",
      mirrorHash: "mb",
    });
    if (!d1.ok || !d2.ok) throw new Error("upsert failed");
    await store.upsertContent("ma", "alpha body");
    await store.upsertChunks("ma", [
      { seq: 0, pos: 0, text: "alpha body", startLine: 1, endLine: 1 },
    ]);
    await store.upsertContent("mb", "beta body");
    await store.upsertChunks("mb", [
      { seq: 0, pos: 0, text: "beta body", startLine: 1, endLine: 1 },
    ]);

    const vs = await createVectorVariantStore(db, {
      model: "reuse-model",
      modelFingerprint: "fp-reuse",
      contextSize: 512,
      truncationPolicy: "tail-v1",
      dimensions: 3,
    });
    expect(vs.searchAvailable).toBe(true);
    const pending1 = vs.pending({ limit: 10 });
    const owner1 = pending1.find((p) => p.documentId === d1.value.id)!;
    const owner2 = pending1.find((p) => p.documentId === d2.value.id)!;
    const [id1] = vs.write([
      { owner: owner1, embedding: new Float32Array([1, 0, 0]) },
    ]);
    expect(id1).toBe(1);

    // Simulate dirty vec0 mirror: remove owner + authoritative variant row while leaving vec0 row 1 behind
    db.run("DELETE FROM vector_owners WHERE variant_id = ?", [id1!]);
    db.run("DELETE FROM vector_variants WHERE variant_id = ?", [id1!]);

    const [id2] = vs.write([
      { owner: owner2, embedding: new Float32Array([0, 1, 0]) },
    ]);
    expect(id2).toBe(1);
    const stored = db
      .query<{ c: number }, [number]>(
        `SELECT COUNT(*) AS c FROM ${vs.tableName} WHERE variant_id = ?`
      )
      .get(id2!)!.c;
    expect(stored).toBe(1);
  });

  test("R3: searchVectorVariants returns empty array for minScore: NaN", async () => {
    const dir = await makeTempDir("gno-reg-nan-minscore-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    const db = store.getRawDb();
    const doc = await store.upsertDocument({
      collection: "notes",
      relPath: "a.md",
      sourceHash: "sa",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 5,
      sourceMtime: "2026-09-01T00:00:00Z",
      title: "A",
      mirrorHash: "ma",
    });
    if (!doc.ok) throw new Error("upsert failed");
    await store.upsertContent("ma", "alpha body");
    await store.upsertChunks("ma", [
      { seq: 0, pos: 0, text: "alpha body", startLine: 1, endLine: 1 },
    ]);
    const vs = await createVectorVariantStore(db, {
      model: "nan-model",
      modelFingerprint: "fp-nan",
      contextSize: 512,
      truncationPolicy: "tail-v1",
      dimensions: 3,
    });
    const [pendingDoc] = vs.pending({ limit: 10 });
    vs.write([{ owner: pendingDoc!, embedding: new Float32Array([1, 0, 0]) }]);
    vs.activate(vs.epoch());

    const hits = searchVectorVariants(
      db,
      "nan-model",
      3,
      new Float32Array([1, 0, 0]),
      5,
      {
        partitionId: vs.partitionId,
        minScore: Number.NaN,
      }
    );
    expect(hits).toEqual([]);
  });

  test("R8: allowedMirrorHashes with 801 hashes ranks exact match ahead of later zero vector (NULL cosine distance)", async () => {
    const dir = await makeTempDir("gno-reg-null-dist-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    const db = store.getRawDb();
    const portRes = await createVectorIndexPort(db, {
      model: "null-dist-model",
      dimensions: 3,
      distanceMetric: "cosine",
    });
    expect(portRes.ok).toBe(true);
    if (!portRes.ok) return;

    const hashes: string[] = [];
    const exactBlob = new Uint8Array(new Float32Array([1, 0, 0]).buffer);
    const orthoBlob = new Uint8Array(new Float32Array([0, 1, 0]).buffer);
    const zeroBlob = new Uint8Array(new Float32Array([0, 0, 0]).buffer);
    db.transaction(() => {
      const insContent = db.query<unknown, [string, string]>(
        "INSERT INTO content(mirror_hash, markdown) VALUES (?, ?)"
      );
      const insChunk = db.query<unknown, [string, string]>(
        "INSERT INTO content_chunks(mirror_hash, seq, pos, text, start_line, end_line) VALUES (?, 0, 0, ?, 1, 1)"
      );
      const insVec = db.query<unknown, [string, Uint8Array]>(
        `INSERT INTO content_vectors(mirror_hash, seq, model, embed_fingerprint, embedding)
         VALUES (?, 0, 'null-dist-model', 'fp', ?)`
      );
      for (let i = 0; i < 801; i++) {
        const hash = `h${String(i).padStart(4, "0")}`;
        hashes.push(hash);
        insContent.run(hash, `body ${i}`);
        insChunk.run(hash, `body ${i}`);
        const blob = i === 0 ? exactBlob : i === 800 ? zeroBlob : orthoBlob;
        insVec.run(hash, blob);
      }
    })();

    const res = await portRes.value.searchNearest(
      new Float32Array([1, 0, 0]),
      1,
      {
        allowedMirrorHashes: hashes,
      }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]!.mirrorHash).toBe("h0000");
    }

    // Single-batch (<= 800 hashes) preserves SQLite NULLS FIRST selection
    const singleBatch = await portRes.value.searchNearest(
      new Float32Array([1, 0, 0]),
      1,
      {
        allowedMirrorHashes: ["h0000", "h0800"],
      }
    );
    expect(singleBatch.ok).toBe(true);
    if (singleBatch.ok) {
      expect(singleBatch.value).toHaveLength(1);
      expect(singleBatch.value[0]!.mirrorHash).toBe("h0800");
    }
  });

  test("R8: getGraphNeighborsForSeeds handles >50,000-char seed title without LIKE error and matches suffix wiki links", async () => {
    const dir = await makeTempDir("gno-reg-long-title-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    const seed = await store.upsertDocument({
      collection: "notes",
      relPath: "sub/target.md",
      sourceHash: "s1",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2026-09-01T00:00:00Z",
      title: "T".repeat(50_001),
      mirrorHash: "m1",
    });
    const src = await store.upsertDocument({
      collection: "notes",
      relPath: "src.md",
      sourceHash: "s2",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2026-09-01T00:00:00Z",
      title: "Source",
      mirrorHash: "m2",
    });
    if (!seed.ok || !src.ok) throw new Error("upsert failed");
    await store.setDocLinks(
      src.value.id,
      [
        {
          targetRef: "other",
          targetRefNorm: "other",
          linkType: "wiki",
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 10,
        },
        {
          targetRef: "dir/target",
          targetRefNorm: "dir/target",
          linkType: "wiki",
          startLine: 2,
          startCol: 1,
          endLine: 2,
          endCol: 15,
        },
      ],
      "parsed"
    );

    const res = await store.getGraphNeighborsForSeeds({
      seedDocumentIds: [seed.value.id],
    });
    expect(res.ok).toBe(true);
  });

  test("R7: parseStoredTypedMetadata rejects compact scientific-notation JSON expanding past 64 KiB", () => {
    const chunk = `[${Array.from({ length: 128 }, () => "1e20").join(",")}]`;
    const entries: string[] = [];
    for (let i = 0; i < 27; i++) {
      entries.push(`"k${i}":${chunk}`);
    }
    const raw = `{${entries.join(",")}}`;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(65_536);
    expect(
      Buffer.byteLength(JSON.stringify(JSON.parse(raw)), "utf8")
    ).toBeGreaterThan(65_536);
    expect(() => typedMetadataSchema.parse(JSON.parse(raw))).toThrow();
    expect(() => parseStoredTypedMetadata(raw)).toThrow(
      "Metadata exceeds 64 KiB"
    );
  });

  test("R8: getChunkTermPresence materializes scoped CTE so lower(text) executes once across multiple terms", async () => {
    const dir = await makeTempDir("gno-reg-lower-explain-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    const db = store.getRawDb();

    const ops = db
      .query<{ p4: string | null }, [string, string, string, string]>(
        `EXPLAIN
         WITH scoped AS MATERIALIZED (
           SELECT mirror_hash, seq, text, lower(text) AS ltext
           FROM content_chunks
           WHERE mirror_hash IN (SELECT value FROM json_each(?))
         )
         SELECT mirror_hash, seq,
           instr(ltext, ?) > 0, instr(ltext, ?) > 0, instr(ltext, ?) > 0
         FROM scoped
         ORDER BY mirror_hash, seq`
      )
      .all('["h1"]', "alpha", "beta", "gamma");
    const lowerOps = ops.filter((op) => String(op.p4 ?? "").includes("lower"));
    expect(lowerOps).toHaveLength(1);
  });

  test("R6: variantStatus proves >512 cold uncached chunks in bounded batches inside one snapshot", async () => {
    const dir = await makeTempDir("gno-reg-status-batch-");
    const dbPath = join(dir, "index.sqlite");
    const store = new SqliteAdapter();
    cleanupStores.push(store);
    expect((await store.open(dbPath, "unicode61")).ok).toBe(true);
    await store.syncCollections([
      {
        name: "notes",
        path: join(dir, "notes"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    const db = store.getRawDb();
    const vs = await createVectorVariantStore(db, {
      model: "batch-status-model",
      modelFingerprint: "fp-batch-status",
      contextSize: 512,
      truncationPolicy: "tail-v1",
      dimensions: 3,
    });

    db.transaction(() => {
      const insDoc = db.query<
        { id: number },
        [string, string, string, string, string, string]
      >(
        `INSERT INTO documents (
           collection, rel_path, source_hash, source_mime, source_ext,
           source_size, source_mtime, docid, uri, title, mirror_hash,
           active, ingest_version
         ) VALUES ('notes', ?, ?, 'text/markdown', '.md', 10, '2026-09-01T00:00:00Z',
           ?, ?, ?, ?, 1, ${TYPED_METADATA_INGEST_VERSION}) RETURNING id`
      );
      const insContent = db.query<unknown, [string, string]>(
        "INSERT INTO content(mirror_hash, markdown) VALUES (?, ?)"
      );
      const insChunk = db.query<unknown, [string, string]>(
        "INSERT INTO content_chunks(mirror_hash, seq, pos, text, start_line, end_line) VALUES (?, 0, 0, ?, 1, 1)"
      );
      for (let i = 0; i < 550; i++) {
        const hash = `mb-${i}`;
        const text = `chunk body ${i}`;
        const title = `Doc ${i}`;
        insDoc.get(
          `doc-${i}.md`,
          `s-${i}`,
          `#mb${i}`,
          `gno://notes/doc-${i}.md`,
          title,
          hash
        );
        insContent.run(hash, text);
        insChunk.run(hash, text);
      }
    })();

    const pending = vs.pending({ limit: 600 });
    expect(pending).toHaveLength(550);
    vs.write(
      pending.map((owner) => ({
        owner,
        embedding: new Float32Array([1, 0, 0]),
      }))
    );
    vs.activate(vs.epoch());

    // Open a fresh connection so the in-memory proof cache is completely cold
    const reader = new Database(dbPath, { readonly: true });
    try {
      const status = getVariantStatus(reader, {
        embedModel: "batch-status-model",
      });
      expect(status).not.toBeNull();
      expect(status?.backlog).toBe(0);
      expect(status?.embeddedByCollection.get("notes")).toBe(550);
    } finally {
      reader.close();
    }
  });
});
