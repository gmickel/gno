/**
 * Contract and regression tests for fn-234: lossless vector search hot fixes
 * and DB hygiene (R1-R5).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdtemp: Bun has no temp-directory utility.
import { mkdtemp } from "node:fs/promises";
// node:os tmpdir: Bun has no OS temp-dir utility.
import { tmpdir } from "node:os";
// node:path join: Bun has no path join utility.
import { join } from "node:path";

import type { VectorVariantIdentity } from "../../../src/store/vector/types";

import {
  computeRequestedMmapSizeBytes,
  SQLITE_PRIMARY_CACHE_SIZE,
  SQLITE_READ_CACHE_SIZE,
  SqliteAdapter,
} from "../../../src/store/sqlite/adapter";
import { getStoredEmbeddingDimensions } from "../../../src/store/vector/freshness";
import {
  pruneLegacyVectors,
  syncPartitionIndex,
} from "../../../src/store/vector/partition-index";
import {
  checkNullCosineVariant,
  persistNullCosineAfterSnapshot,
} from "../../../src/store/vector/proof-cache";
import {
  createVectorIndexPort,
  modelTableName,
} from "../../../src/store/vector/sqlite-vec";
import { createVectorStatsPort } from "../../../src/store/vector/stats";
import {
  searchVectorVariants,
  searchVectorVariantsBatch,
} from "../../../src/store/vector/variant-search";
import {
  createVectorVariantStore,
  loadSqliteVec,
} from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const MODEL = "hf:test/fn234-embed.gguf";
const DIMS = 4;

function makeIdentity(model = MODEL): VectorVariantIdentity {
  return {
    model,
    dimensions: DIMS,
    modelFingerprint: `fp-${model}`,
    contextSize: 512,
    truncationPolicy: "tail-truncate",
  };
}

const cleanupDirs: string[] = [];
const cleanupStores: SqliteAdapter[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function openTempStore(prefix = "gno-fn234-"): Promise<{
  dir: string;
  dbPath: string;
  store: SqliteAdapter;
  db: Database;
}> {
  const dir = await makeTempDir(prefix);
  const dbPath = join(dir, "index.sqlite");
  const store = new SqliteAdapter();
  cleanupStores.push(store);
  const res = await store.open(dbPath, "unicode61");
  expect(res.ok).toBe(true);
  return { dir, dbPath, store, db: store.getRawDb() };
}

function seedCollectionAndDoc(
  db: Database,
  opts: {
    collection: string;
    relPath: string;
    docid: string;
    mirrorHash: string;
    text: string;
    language?: string | null;
    active?: number;
    insertChunk?: boolean;
  }
): number {
  db.run(
    `INSERT OR IGNORE INTO collections (name, path, pattern, synced_at)
     VALUES (?, '/tmp/col', '**/*.md', datetime('now'))`,
    [opts.collection]
  );
  db.run(
    `INSERT OR IGNORE INTO content (mirror_hash, markdown, created_at)
     VALUES (?, ?, datetime('now'))`,
    [opts.mirrorHash, opts.text]
  );
  if (opts.insertChunk !== false) {
    db.run(
      `INSERT OR IGNORE INTO content_chunks
         (mirror_hash, seq, pos, text, start_line, end_line, language, token_count, created_at)
       VALUES (?, 0, 0, ?, 1, 1, ?, 10, datetime('now'))`,
      [opts.mirrorHash, opts.text, opts.language ?? null]
    );
  }
  const active = opts.active ?? 1;
  const info = db
    .query<
      { id: number },
      [string, string, string, string, string, string, string, number]
    >(
      `INSERT INTO documents
         (collection, rel_path, source_hash, source_mime, source_ext, source_size, source_mtime,
          docid, uri, title, mirror_hash, active, ingest_version, created_at, updated_at)
       VALUES (?, ?, ?, 'text/markdown', '.md', 10, datetime('now'),
               ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       RETURNING id`
    )
    .get(
      opts.collection,
      opts.relPath,
      `src-${opts.docid}`,
      opts.docid,
      `gno://${opts.collection}/${opts.relPath}`,
      opts.relPath,
      opts.mirrorHash,
      active
    );
  return info!.id;
}

afterEach(async () => {
  for (const store of cleanupStores.splice(0)) {
    await store.close();
  }
  for (const dir of cleanupDirs.splice(0)) {
    await safeRm(dir);
  }
});

describe("fn-234 R1: durable per-partition null_cosine tracking", () => {
  test("persists null_cosine=0 on activate/sync, survives cold opens and doc/chunk edits, and invalidates on raw SQL vector_variants change", async () => {
    const { dbPath, store, db } = await openTempStore("gno-fn234-r1-");
    const identity = makeIdentity();
    const docId = seedCollectionAndDoc(db, {
      collection: "notes",
      relPath: "a.md",
      docid: "#a1",
      mirrorHash: "hash-a1",
      text: "alpha note",
    });

    const vstore = await createVectorVariantStore(db, identity);
    expect(vstore.searchAvailable).toBe(true);
    const owner = vstore.current(docId, 0)!;
    expect(owner).not.toBeNull();
    vstore.writeCurrent([{ owner, embedding: new Float32Array([1, 0, 0, 0]) }]);
    vstore.activate(vstore.epoch());

    // Persisted null_cosine = 0 right after activation
    const rowAfterActivate = db
      .query<{ dirty: number; null_cosine: number | null }, [string]>(
        "SELECT dirty, null_cosine FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(vstore.partitionId);
    expect(rowAfterActivate).toEqual({ dirty: 0, null_cosine: 0 });

    // Editing documents / content_chunks must NOT invalidate null_cosine
    db.run("UPDATE documents SET title = 'renamed' WHERE id = ?", [docId]);
    db.run("UPDATE content_chunks SET language = 'en' WHERE mirror_hash = ?", [
      "hash-a1",
    ]);
    const rowAfterDocEdit = db
      .query<{ dirty: number; null_cosine: number | null }, [string]>(
        "SELECT dirty, null_cosine FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(vstore.partitionId);
    expect(rowAfterDocEdit).toEqual({ dirty: 0, null_cosine: 0 });

    // Cold connection reads null_cosine=0 without scanning vector_variants
    const coldStore = new SqliteAdapter();
    cleanupStores.push(coldStore);
    expect((await coldStore.open(dbPath, "unicode61")).ok).toBe(true);
    const coldDb = coldStore.getRawDb();
    expect(await loadSqliteVec(coldDb)).toBe(true);
    const check = checkNullCosineVariant(coldDb, vstore.partitionId, false);
    expect(check.found).toBe(false);
    expect(check.persistAfterSnapshot).toBeUndefined();

    // Downgrade simulation: older binary writes (partition_id, dirty) -> null_cosine resets to NULL
    db.run(
      "INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty) VALUES (?, 0)",
      [vstore.partitionId]
    );
    const downgraded = db
      .query<{ dirty: number; null_cosine: number | null }, [string]>(
        "SELECT dirty, null_cosine FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(vstore.partitionId);
    expect(downgraded).toEqual({ dirty: 0, null_cosine: null });

    // Reader falls back to probe and returns persistAfterSnapshot payload
    const fallbackCheck = checkNullCosineVariant(db, vstore.partitionId, false);
    expect(fallbackCheck.found).toBe(false);
    expect(fallbackCheck.persistAfterSnapshot).toBeDefined();

    // Guarded persist succeeds when epoch matches
    persistNullCosineAfterSnapshot(db, fallbackCheck.persistAfterSnapshot!);
    const afterPersist = db
      .query<{ null_cosine: number | null }, [string]>(
        "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(vstore.partitionId);
    expect(afterPersist?.null_cosine).toBe(0);

    // Guarded persist is skipped when epoch has changed
    db.run(
      "UPDATE vector_mirror_state SET null_cosine = NULL WHERE partition_id = ?",
      [vstore.partitionId]
    );
    const stalePayload = {
      ...fallbackCheck.persistAfterSnapshot!,
      epoch: fallbackCheck.persistAfterSnapshot!.epoch - 1,
    };
    persistNullCosineAfterSnapshot(db, stalePayload);
    expect(
      db
        .query<{ null_cosine: number | null }, [string]>(
          "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
        )
        .get(vstore.partitionId)?.null_cosine
    ).toBeNull();

    // Read-only connection encountering null_cosine=NULL never writes and succeeds
    const roStore = new SqliteAdapter();
    cleanupStores.push(roStore);
    expect(roStore.openReadOnly(dbPath).ok).toBe(true);
    const roDb = roStore.getRawDb();
    expect(await loadSqliteVec(roDb)).toBe(true);
    const roHits = searchVectorVariants(
      roDb,
      MODEL,
      DIMS,
      new Float32Array([1, 0, 0, 0]),
      5,
      { embeddingIdentity: identity }
    );
    // Title was edited above so owner proof drops it; query still succeeds without writing
    expect(roHits).not.toBeNull();
    expect(
      db
        .query<{ null_cosine: number | null }, [string]>(
          "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
        )
        .get(vstore.partitionId)?.null_cosine
    ).toBeNull();

    // Raw SQL mutation on vector_variants removes the mirror_state row via 036 trigger
    syncPartitionIndex(db, {
      partitionId: vstore.partitionId,
      dimensions: DIMS,
    });
    expect(
      db
        .query<{ null_cosine: number | null }, [string]>(
          "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
        )
        .get(vstore.partitionId)?.null_cosine
    ).toBe(0);
    db.run(
      "UPDATE vector_variants SET embedding = embedding WHERE partition_id = ?",
      [vstore.partitionId]
    );
    expect(
      db
        .query("SELECT 1 FROM vector_mirror_state WHERE partition_id = ?")
        .get(vstore.partitionId)
    ).toBeNull();
    await store.close();
  });

  test("detects all-zero, float32 underflow (1e-30), and overflow (1e30) via SQL predicate and resets on release", async () => {
    const cases: Array<{ label: string; vec: Float32Array }> = [
      { label: "zero", vec: new Float32Array([0, 0, 0, 0]) },
      {
        label: "underflow-1e-30",
        vec: new Float32Array([1e-30, 1e-30, 1e-30, 1e-30]),
      },
      {
        label: "overflow-1e30",
        vec: new Float32Array([1e30, 1e30, 1e30, 1e30]),
      },
    ];

    for (const c of cases) {
      const { db } = await openTempStore(`gno-fn234-${c.label}-`);
      const identity = makeIdentity();
      const docNormal = seedCollectionAndDoc(db, {
        collection: "notes",
        relPath: "normal.md",
        docid: "#n1",
        mirrorHash: "hash-n1",
        text: "normal doc",
      });
      const docNull = seedCollectionAndDoc(db, {
        collection: "notes",
        relPath: "bad.md",
        docid: "#b1",
        mirrorHash: "hash-b1",
        text: "bad doc",
      });

      const vstore = await createVectorVariantStore(db, identity);
      vstore.writeCurrent([
        {
          owner: vstore.current(docNormal, 0)!,
          embedding: new Float32Array([1, 0, 0, 0]),
        },
        {
          owner: vstore.current(docNull, 0)!,
          embedding: new Float32Array([0, 1, 0, 0]),
        },
      ]);
      vstore.activate(vstore.epoch());
      expect(
        db
          .query<{ null_cosine: number | null }, [string]>(
            "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
          )
          .get(vstore.partitionId)?.null_cosine
      ).toBe(0);

      // Overwrite docNull's embedding with a null-cosine vector -> mark flips to 1 immediately
      vstore.writeCurrent([
        {
          owner: vstore.current(docNull, 0)!,
          embedding: c.vec,
        },
      ]);
      expect(
        db
          .query<{ null_cosine: number | null }, [string]>(
            "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
          )
          .get(vstore.partitionId)?.null_cosine
      ).toBe(1);

      // Search must preserve SQLite NULLS FIRST / exact parity
      const hits = searchVectorVariants(
        db,
        MODEL,
        DIMS,
        new Float32Array([1, 0, 0, 0]),
        5,
        { embeddingIdentity: identity }
      );
      // Force exact path via scoped collection filter (same doc set)
      const exactHits = searchVectorVariants(
        db,
        MODEL,
        DIMS,
        new Float32Array([1, 0, 0, 0]),
        5,
        { embeddingIdentity: identity, eligibility: { collection: "notes" } }
      );
      expect(hits).toEqual(exactHits);

      // Release removes the offending variant -> null_cosine resets to NULL
      vstore.release(docNull);
      expect(
        db
          .query<{ null_cosine: number | null }, [string]>(
            "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
          )
          .get(vstore.partitionId)?.null_cosine
      ).toBeNull();

      // Recompute via syncPartitionIndex -> back to 0
      syncPartitionIndex(db, {
        partitionId: vstore.partitionId,
        dimensions: DIMS,
      });
      expect(
        db
          .query<{ null_cosine: number | null }, [string]>(
            "SELECT null_cosine FROM vector_mirror_state WHERE partition_id = ?"
          )
          .get(vstore.partitionId)?.null_cosine
      ).toBe(0);
    }
  });
});

describe("fn-234 R2: skip unconditional content_chunks join with exact parity", () => {
  test("exact single and batch scans maintain parity across filters, multi-owner, stale-owner, and missing chunk rows", async () => {
    const { db } = await openTempStore("gno-fn234-r2-");
    const identity = makeIdentity();

    const d1 = seedCollectionAndDoc(db, {
      collection: "alpha",
      relPath: "a.md",
      docid: "#d1",
      mirrorHash: "h1",
      text: "doc one",
      language: "en",
    });
    const d2 = seedCollectionAndDoc(db, {
      collection: "alpha",
      relPath: "b.md",
      docid: "#d2",
      mirrorHash: "h1", // shared content with d1 (multi-owner)
      text: "doc one",
      language: "en",
    });
    const d3 = seedCollectionAndDoc(db, {
      collection: "beta",
      relPath: "c.md",
      docid: "#d3",
      mirrorHash: "h3",
      text: "doc three",
      language: "de",
    });
    const dMissingChunk = seedCollectionAndDoc(db, {
      collection: "alpha",
      relPath: "missing-chunk.md",
      docid: "#d4",
      mirrorHash: "h4",
      text: "orphan chunk doc",
      language: "en",
      insertChunk: true,
    });
    const dStale = seedCollectionAndDoc(db, {
      collection: "alpha",
      relPath: "stale.md",
      docid: "#d5",
      mirrorHash: "h5",
      text: "stale doc",
      language: "en",
      active: 1,
    });

    const vstore = await createVectorVariantStore(db, identity);
    // Give d1 and d2 the same title so they share the exact formatted input variant
    db.run("UPDATE documents SET title = 'shared' WHERE id IN (?, ?)", [
      d1,
      d2,
    ]);
    vstore.writeCurrent([
      {
        owner: vstore.current(d1, 0)!,
        embedding: new Float32Array([0.9, 0.1, 0, 0]),
      },
      {
        owner: vstore.current(d2, 0)!,
        embedding: new Float32Array([0.9, 0.1, 0, 0]),
      },
      {
        owner: vstore.current(d3, 0)!,
        embedding: new Float32Array([0.7, 0.7, 0, 0]),
      },
      // Missing-chunk doc has the CLOSEST embedding so it enters top candidates first
      {
        owner: vstore.current(dMissingChunk, 0)!,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
      {
        owner: vstore.current(dStale, 0)!,
        embedding: new Float32Array([0.95, 0.05, 0, 0]),
      },
    ]);
    vstore.activate(vstore.epoch());

    // Remove the chunk row for dMissingChunk (leaving bound vector_owners row)
    db.run("DELETE FROM content_chunks WHERE mirror_hash = 'h4'");
    // Make dStale inactive so its owner is stale
    db.run("UPDATE documents SET active = 0 WHERE id = ?", [dStale]);

    const q = new Float32Array([1, 0, 0, 0]);

    // Scoped to alpha, k=1: missing-chunk & stale must be dropped, d1+d2 returned
    const singleAlpha = searchVectorVariants(db, MODEL, DIMS, q, 1, {
      embeddingIdentity: identity,
      eligibility: { collection: "alpha" },
    });
    expect(singleAlpha).not.toBeNull();
    expect(singleAlpha!.length).toBe(1);
    expect(singleAlpha![0]!.mirrorHash).toBe("h1");
    expect(singleAlpha![0]!.documentIds).toEqual([d1, d2]);

    // Batched exact scan must match single exact scan bit-for-bit
    const batchAlpha = searchVectorVariantsBatch(
      db,
      MODEL,
      DIMS,
      [q, new Float32Array([0, 1, 0, 0])],
      [1, 1],
      { embeddingIdentity: identity, eligibility: { collection: "alpha" } }
    );
    expect(batchAlpha).not.toBeNull();
    expect(batchAlpha![0]).toEqual(singleAlpha!);

    // Language filter keeps content_chunks join and returns only German doc
    const singleLang = searchVectorVariants(db, MODEL, DIMS, q, 5, {
      embeddingIdentity: identity,
      eligibility: { language: "de" },
    });
    expect(singleLang?.map((h) => h.mirrorHash)).toEqual(["h3"]);

    const batchLang = searchVectorVariantsBatch(db, MODEL, DIMS, [q], [5], {
      embeddingIdentity: identity,
      eligibility: { language: "de" },
    });
    expect(batchLang?.[0]).toEqual(singleLang!);

    // Empty eligible set returns [] without error
    expect(
      searchVectorVariants(db, MODEL, DIMS, q, 5, {
        embeddingIdentity: identity,
        eligibility: { collection: "nonexistent" },
      })
    ).toEqual([]);
    expect(
      searchVectorVariantsBatch(db, MODEL, DIMS, [q], [5], {
        embeddingIdentity: identity,
        eligibility: { collection: "nonexistent" },
      })
    ).toEqual([[]]);
  });
});

describe("fn-234 R3: SQLite mmap_size and cache_size helper", () => {
  test("computes bounded mmap_size for 64-bit, low-RAM, and 32-bit hosts and keeps page_size 4096", async () => {
    expect(computeRequestedMmapSizeBytes(32 * 1024 ** 3, true)).toBe(
      8 * 1024 ** 3
    );
    expect(computeRequestedMmapSizeBytes(2 * 1024 ** 3, true)).toBe(
      1 * 1024 ** 3
    );
    expect(computeRequestedMmapSizeBytes(32 * 1024 ** 3, false)).toBe(
      268435456
    );

    const { db, store, dbPath } = await openTempStore("gno-fn234-r3-");
    expect(
      db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size
    ).toBe(4096);
    expect(
      db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
        ?.cache_size
    ).toBe(SQLITE_PRIMARY_CACHE_SIZE);
    const primaryMmap =
      db.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()
        ?.mmap_size ?? -1;
    expect(primaryMmap).toBeGreaterThanOrEqual(0);

    await store.withReadConnection(async () => {
      const readDb = store.getRawDb();
      expect(
        readDb.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
          ?.cache_size
      ).toBe(SQLITE_READ_CACHE_SIZE);
      expect(
        readDb.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()
          ?.mmap_size
      ).toBe(primaryMmap);
    });

    const roStore = new SqliteAdapter();
    cleanupStores.push(roStore);
    expect(roStore.openReadOnly(dbPath).ok).toBe(true);
    const roDb = roStore.getRawDb();
    expect(
      roDb.query<{ cache_size: number }, []>("PRAGMA cache_size").get()
        ?.cache_size
    ).toBe(SQLITE_READ_CACHE_SIZE);
    expect(
      roDb.query<{ mmap_size: number }, []>("PRAGMA mmap_size").get()?.mmap_size
    ).toBe(primaryMmap);
  });
});

describe("fn-234 R4: legacy vector hygiene and prune safety", () => {
  test("skips eager vec_<hash> creation when v1 active, searches without it, and safely prunes only activated models + orphaned vec_v1", async () => {
    const { db, store, dbPath } = await openTempStore("gno-fn234-r4-");
    const shadowModel = "hf:test/shadow-only.gguf";
    const legacyOnlyModel = "hf:test/legacy-only.gguf";

    const d1 = seedCollectionAndDoc(db, {
      collection: "notes",
      relPath: "a.md",
      docid: "#a1",
      mirrorHash: "ha1",
      text: "hello world",
    });

    // Seed legacy content_vectors + vec_<hash> for active, shadow-only, and legacy-only models
    expect(await loadSqliteVec(db)).toBe(true);
    const activeLegacyTable = modelTableName(MODEL);
    const shadowLegacyTable = modelTableName(shadowModel);
    const legacyOnlyTable = modelTableName(legacyOnlyModel);
    const blob = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);

    for (const [m, tbl] of [
      [MODEL, activeLegacyTable],
      [shadowModel, shadowLegacyTable],
      [legacyOnlyModel, legacyOnlyTable],
    ] as const) {
      db.run(
        `INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at, embed_fingerprint)
         VALUES ('ha1', 0, ?, ?, datetime('now'), 'fp')`,
        [m, blob]
      );
      db.exec(
        `CREATE VIRTUAL TABLE "${tbl}" USING vec0(mirror_hash text, seq integer, embedding float[${DIMS}] distance_metric=cosine)`
      );
    }

    // Create an orphaned vec_v1_<64hex> table not in vector_partitions
    const orphanPartitionId = "a".repeat(64);
    const orphanTable = `vec_v1_${orphanPartitionId}`;
    db.exec(
      `CREATE VIRTUAL TABLE "${orphanTable}" USING vec0(variant_id integer primary key, embedding float[${DIMS}] distance_metric=cosine)`
    );
    db.run(
      "INSERT INTO vector_mirror_state (partition_id, dirty) VALUES (?, 0)",
      [orphanPartitionId]
    );

    // Activate v1 partition for MODEL; keep shadowModel strictly shadow
    const activeIdentity = makeIdentity(MODEL);
    const activeStore = await createVectorVariantStore(db, activeIdentity);
    activeStore.writeCurrent([
      {
        owner: activeStore.current(d1, 0)!,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
    ]);
    activeStore.activate(activeStore.epoch());

    const shadowStore = await createVectorVariantStore(
      db,
      makeIdentity(shadowModel)
    );
    shadowStore.writeCurrent([
      {
        owner: shadowStore.current(d1, 0)!,
        embedding: new Float32Array([1, 0, 0, 0]),
      },
    ]);
    // Note: shadowStore is NOT activated

    // Capture pre-prune stats/status/dims for parity check
    const statsPort = createVectorStatsPort(db);
    const preStatus = await store.getStatus({ embedModel: MODEL });
    const preCount = await statsPort.countVectors(MODEL);
    const preDims = getStoredEmbeddingDimensions(db, MODEL);
    expect(preStatus.ok).toBe(true);
    expect(preCount.ok && preCount.value).toBe(1);
    expect(preDims).toBe(DIMS);

    // Fail closed when sqlite-vec is unavailable
    const noExt = await pruneLegacyVectors(db, {
      loadSqliteVec: async () => false,
    });
    expect(noExt.ok).toBe(false);

    // Fail closed on read-only DB
    const roStore = new SqliteAdapter();
    cleanupStores.push(roStore);
    expect(roStore.openReadOnly(dbPath).ok).toBe(true);
    const roPrune = await pruneLegacyVectors(roStore.getRawDb());
    expect(roPrune.ok).toBe(false);

    // Real prune succeeds
    const pruned = await pruneLegacyVectors(db);
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) throw new Error(pruned.error);
    expect(
      [...pruned.droppedTables].sort((a, b) => a.localeCompare(b))
    ).toEqual(
      [activeLegacyTable, orphanTable].sort((a, b) => a.localeCompare(b))
    );
    expect(pruned.removedRows).toBe(1);

    // Active legacy table dropped; shadow + legacy-only tables and active vec_v1 preserved
    const tables = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        .all()
        .map((r) => r.name)
    );
    expect(tables.has(activeLegacyTable)).toBe(false);
    expect(tables.has(orphanTable)).toBe(false);
    expect(tables.has(`vec_v1_${activeStore.partitionId}`)).toBe(true);
    expect(tables.has(shadowLegacyTable)).toBe(true);
    expect(tables.has(legacyOnlyTable)).toBe(true);

    // Shadow and legacy-only content_vectors rows untouched
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM content_vectors WHERE model = ?"
        )
        .get(MODEL)?.c
    ).toBe(0);
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM content_vectors WHERE model = ?"
        )
        .get(shadowModel)?.c
    ).toBe(1);
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM content_vectors WHERE model = ?"
        )
        .get(legacyOnlyModel)?.c
    ).toBe(1);

    // Second prune on clean DB is a zero-op
    const secondPrune = await pruneLegacyVectors(db);
    expect(secondPrune.ok).toBe(true);
    if (secondPrune.ok) {
      expect(secondPrune.droppedTables).toEqual([]);
      expect(secondPrune.removedRows).toBe(0);
    }

    // Post-prune stats, status, and stored dimensions match pre-prune values
    const postStatus = await store.getStatus({ embedModel: MODEL });
    const postCount = await statsPort.countVectors(MODEL);
    const postDims = getStoredEmbeddingDimensions(db, MODEL);
    expect(postStatus.ok).toBe(true);
    if (preStatus.ok && postStatus.ok) {
      expect(postStatus.value.embeddingBacklog).toBe(
        preStatus.value.embeddingBacklog
      );
      expect(postStatus.value.vectorPartitions).toEqual(
        preStatus.value.vectorPartitions
      );
    }
    expect(postCount.ok && postCount.value).toBe(1);
    expect(postDims).toBe(DIMS);

    // Opening VectorIndexPort for activated model must NOT recreate legacy vec_<hash>
    const portRes = await createVectorIndexPort(db, {
      model: MODEL,
      dimensions: DIMS,
    });
    expect(portRes.ok).toBe(true);
    if (!portRes.ok) throw new Error(portRes.error.message);
    const port = portRes.value;
    expect(port.searchAvailable).toBe(true);
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(activeLegacyTable)
    ).toBeNull();

    // searchNearest and searchNearestBatch work without legacy vec_<hash>
    const single = await port.searchNearest(new Float32Array([1, 0, 0, 0]), 5, {
      embeddingIdentity: activeIdentity,
    });
    expect(single.ok && single.value.length).toBe(1);
    const batch = await port.searchNearestBatch!(
      [new Float32Array([1, 0, 0, 0])],
      [5],
      { embeddingIdentity: activeIdentity }
    );
    expect(batch.ok && batch.value[0]?.length).toBe(1);

    // syncVecIndex and rebuildVecIndex do not recreate legacy vec_<hash>
    expect((await port.syncVecIndex()).ok).toBe(true);
    expect((await port.rebuildVecIndex()).ok).toBe(true);
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(activeLegacyTable)
    ).toBeNull();
  });
});

describe("fn-234 R5: json_each-driven listDocumentsForSimilarity query plan and filtering", () => {
  test("EXPLAIN QUERY PLAN uses PK and idx_documents_mirror_hash seeks without collection scan or Bloom filter", async () => {
    const { db, store } = await openTempStore("gno-fn234-r5-");

    // Seed enough rows across two collections so SQLite stats matter
    const targetId = seedCollectionAndDoc(db, {
      collection: "notes",
      relPath: "keep-id.md",
      docid: "#k1",
      mirrorHash: "hk1",
      text: "keep by id",
    });
    seedCollectionAndDoc(db, {
      collection: "notes",
      relPath: "keep-hash.md",
      docid: "#k2",
      mirrorHash: "hk2",
      text: "keep by hash",
    });
    const inactiveId = seedCollectionAndDoc(db, {
      collection: "notes",
      relPath: "inactive.md",
      docid: "#k3",
      mirrorHash: "hk3",
      text: "inactive doc",
      active: 0,
    });
    const otherColId = seedCollectionAndDoc(db, {
      collection: "other",
      relPath: "other.md",
      docid: "#k4",
      mirrorHash: "hk4",
      text: "other collection",
    });
    for (let i = 0; i < 40; i++) {
      seedCollectionAndDoc(db, {
        collection: "notes",
        relPath: `filler-${i}.md`,
        docid: `#f${i}`,
        mirrorHash: `hf-${i}`,
        text: `filler ${i}`,
      });
    }
    db.exec("ANALYZE");

    // Inspect exact query plan matching listDocumentsForSimilarity
    const planSql = `
      EXPLAIN QUERY PLAN
      SELECT d.id AS id, d.docid, d.uri, d.title, d.collection, d.rel_path, d.mirror_hash
      FROM json_each(?) AS j
      CROSS JOIN documents d ON d.id = j.value
      WHERE d.active = 1 AND d.mirror_hash IS NOT NULL AND d.collection = ?
      UNION
      SELECT d.id AS id, d.docid, d.uri, d.title, d.collection, d.rel_path, d.mirror_hash
      FROM json_each(?) AS j
      CROSS JOIN documents d INDEXED BY idx_documents_mirror_hash ON d.mirror_hash = j.value
      WHERE d.active = 1 AND d.mirror_hash IS NOT NULL AND d.collection = ?
      ORDER BY 1
    `;
    const planDetails = db
      .query<{ detail: string }, [string, string, string, string]>(planSql)
      .all(
        JSON.stringify([targetId]),
        "notes",
        JSON.stringify(["hk2"]),
        "notes"
      )
      .map((r) => r.detail)
      .join("\n");

    expect(planDetails).toContain(
      "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)"
    );
    expect(planDetails).toContain(
      "SEARCH d USING INDEX idx_documents_mirror_hash (mirror_hash=?)"
    );
    expect(planDetails).not.toContain("idx_documents_collection");
    expect(planDetails).not.toContain("BLOOM FILTER");

    // Empty inputs return [] without querying
    const empty = await store.listDocumentsForSimilarity({
      documentIds: [],
      mirrorHashes: [],
      collection: "notes",
    });
    expect(empty.ok && empty.value).toEqual([]);

    // Scoped lookup returns active matching rows in collection only, deduplicated & sorted
    const scoped = await store.listDocumentsForSimilarity({
      documentIds: [targetId, inactiveId, otherColId],
      mirrorHashes: ["hk1", "hk2", "hk4"],
      collection: "notes",
    });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.value.map((d) => d.docid)).toEqual(["#k1", "#k2"]);
    }

    // Cross-collection lookup includes active rows from other collection
    const cross = await store.listDocumentsForSimilarity({
      documentIds: [targetId, otherColId],
      mirrorHashes: ["hk2"],
    });
    expect(cross.ok).toBe(true);
    if (cross.ok) {
      expect(cross.value.map((d) => d.docid)).toEqual(["#k1", "#k2", "#k4"]);
    }
  });
});
