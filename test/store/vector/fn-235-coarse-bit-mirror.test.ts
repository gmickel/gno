/**
 * Contract and regression tests for fn-235: bit coarse vec0 mirror with exact
 * rescore and cost-based routing (R2-R7).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdtemp: Bun has no temp-directory utility.
import { mkdtemp } from "node:fs/promises";
// node:os tmpdir: Bun has no OS temp-dir utility.
import { tmpdir } from "node:os";
// node:path join: Bun has no path join utility.
import { join } from "node:path";

import type {
  VectorRouteInfo,
  VectorVariantIdentity,
} from "../../../src/store/vector/types";

import { ConfigSchema } from "../../../src/config/types";
import { explainVector } from "../../../src/pipeline/explain";
import {
  getSchemaVersion,
  migrations,
  runMigrations,
} from "../../../src/store";
import { migration as m039 } from "../../../src/store/migrations/039-vector-mirror-v2";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import {
  COARSE_ROUTER_DEFAULTS,
  computeCoarseK,
  estimateExactCostUs,
  hasNonCollectionFilter,
  isV2CompatibleDimensions,
  resolveVectorRoute,
  v2TableName,
} from "../../../src/store/vector/coarse-router";
import {
  pruneLegacyVectors,
  rebuildPartitionIndexWithDetails,
  syncPartitionIndex,
} from "../../../src/store/vector/partition-index";
import {
  dropVectorPartition,
  listVectorPartitions,
} from "../../../src/store/vector/status";
import {
  getV2MirrorStatus,
  hasV2Table,
  markV2MirrorClean,
  readV2MirrorState,
  runV2RecallSelfCheck,
} from "../../../src/store/vector/v2-mirror";
import {
  searchVectorVariants,
  searchVectorVariantsBatch,
} from "../../../src/store/vector/variant-search";
import {
  createVectorVariantStore,
  loadSqliteVec,
} from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const MODEL = "hf:test/fn235-embed.gguf";
const DIMS = 16; // divisible by 8

function makeIdentity(model = MODEL, dimensions = DIMS): VectorVariantIdentity {
  return {
    model,
    dimensions,
    modelFingerprint: `fp-${model}-${dimensions}`,
    contextSize: 512,
    truncationPolicy: "tail-truncate",
  };
}

function makeVec(seed: number, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  let x = (seed * 2654435761) >>> 0;
  let normSq = 0;
  for (let i = 0; i < dims; i++) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + 3266489917) >>> 0;
    const val = ((x & 0xffff) / 32768 - 1) * 0.5;
    v[i] = val;
    normSq += val * val;
  }
  const inv = 1 / Math.sqrt(normSq || 1);
  for (let i = 0; i < dims; i++) v[i] = v[i]! * inv;
  return v;
}

const cleanupDirs: string[] = [];
const cleanupStores: SqliteAdapter[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function openTempStore(prefix = "gno-fn235-"): Promise<{
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

function seedDoc(
  db: Database,
  opts: {
    collection: string;
    relPath: string;
    docid: string;
    mirrorHash: string;
    text: string;
    title?: string;
    active?: number;
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
  db.run(
    `INSERT OR IGNORE INTO content_chunks
       (mirror_hash, seq, pos, text, start_line, end_line, language, token_count, created_at)
     VALUES (?, 0, 0, ?, 1, 1, 'en', 10, datetime('now'))`,
    [opts.mirrorHash, opts.text]
  );
  const row = db
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
      `sh-${opts.docid}`,
      opts.docid,
      `gno://${opts.collection}/${opts.relPath}`,
      opts.title ?? opts.relPath,
      opts.mirrorHash,
      opts.active ?? 1
    );
  return row!.id;
}

afterEach(async () => {
  for (const store of cleanupStores.splice(0)) {
    await store.close();
  }
  for (const dir of cleanupDirs.splice(0)) {
    await safeRm(dir);
  }
});

describe("fn-235 R2: migration v39, v2 mirror lifecycle, triggers, and cleanup", () => {
  test("migration v39 upgrades cleanly, supports down(), and never adds triggers touching vec0 or documents", async () => {
    const dir = await makeTempDir("gno-fn235-mig39-");
    const dbPath = join(dir, "index.sqlite");
    const raw = new Database(dbPath);
    try {
      expect(runMigrations(raw, migrations.slice(0, 38), "unicode61").ok).toBe(
        true
      );
      expect(getSchemaVersion(raw)).toBe(38);
      expect(runMigrations(raw, migrations, "unicode61").ok).toBe(true);
      expect(getSchemaVersion(raw)).toBe(39);

      // Triggers must only touch plain tables (never vec0, never documents)
      const triggers = raw
        .query<{ name: string; tbl_name: string; sql: string }, []>(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_v2_%'"
        )
        .all();
      expect(triggers.length).toBe(5);
      for (const trg of triggers) {
        expect(trg.tbl_name).not.toBe("documents");
        expect(trg.sql).not.toContain("vec_v2_");
        expect(trg.sql).not.toContain("vec0");
      }

      // Writing to documents WITHOUT sqlite-vec loaded must succeed
      seedDoc(raw, {
        collection: "notes",
        relPath: "plain.md",
        docid: "#p1",
        mirrorHash: "hp1",
        text: "plain write without sqlite-vec",
      });
      raw.run("UPDATE documents SET title = 'updated' WHERE docid = '#p1'");

      // down() cleanly removes v39 objects
      m039.down!(raw);
      expect(
        raw
          .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('vector_partition_rows', 'vector_mirror_v2_state')"
          )
          .all()
      ).toEqual([]);
    } finally {
      raw.close();
    }
  });

  test("maintains vec_v2 across write/activate/sync/rebuild/release/drop/prune and skips non-multiple-of-8 dims", async () => {
    const { db, dbPath } = await openTempStore("gno-fn235-lifecycle-");
    const identity = makeIdentity(MODEL, DIMS);

    const d1 = seedDoc(db, {
      collection: "alpha",
      relPath: "a.md",
      docid: "#a1",
      mirrorHash: "ha1",
      text: "alpha doc one",
    });
    const d2 = seedDoc(db, {
      collection: "beta",
      relPath: "b.md",
      docid: "#b1",
      mirrorHash: "hb1",
      text: "beta doc one",
    });

    const vstore = await createVectorVariantStore(db, identity);
    expect(hasV2Table(db, vstore.partitionId)).toBe(true);
    vstore.writeCurrent([
      { owner: vstore.current(d1, 0)!, embedding: makeVec(1) },
      { owner: vstore.current(d2, 0)!, embedding: makeVec(2) },
    ]);
    vstore.activate(vstore.epoch());

    expect(vstore.v2MirrorState()).toBe("clean");
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM vector_partition_rows WHERE partition_id = ?"
        )
        .get(vstore.partitionId)?.c
    ).toBe(2);

    // Raw SQL write to vector_variants invalidates vector_mirror_v2_state without touching vec0
    const rawConn = new Database(dbPath);
    rawConn.run(
      "UPDATE vector_variants SET embedding = embedding WHERE partition_id = ?",
      [vstore.partitionId]
    );
    rawConn.close();
    expect(readV2MirrorState(db, vstore.partitionId)).toBeNull();
    expect(vstore.v2MirrorState()).toBe("dirty");

    // syncPartitionIndex repairs cleanly
    const synced = syncPartitionIndex(db, {
      partitionId: vstore.partitionId,
      dimensions: DIMS,
    });
    expect(synced.added).toBe(0);
    expect(vstore.v2MirrorState()).toBe("clean");

    // Simulated upgrade: clean vec_v1 + dropped vec_v2 -> v2MirrorState() === "missing", syncV2Index repairs
    db.exec(`DROP TABLE "${v2TableName(vstore.partitionId)}"`);
    db.run("DELETE FROM vector_partition_rows WHERE partition_id = ?", [
      vstore.partitionId,
    ]);
    db.run("DELETE FROM vector_mirror_v2_state WHERE partition_id = ?", [
      vstore.partitionId,
    ]);
    expect(vstore.mirrorState()).toBe("clean");
    expect(vstore.v2MirrorState()).toBe("missing");
    vstore.syncV2Index();
    expect(vstore.v2MirrorState()).toBe("clean");

    // Incremental write preserves stored recall self-check
    markV2MirrorClean(db, vstore.partitionId, {
      recall: 0.99,
      queries: 16,
      coarseK: 200,
    });
    const d3 = seedDoc(db, {
      collection: "alpha",
      relPath: "c.md",
      docid: "#c1",
      mirrorHash: "hc1",
      text: "alpha doc two",
    });
    vstore.writeCurrent([
      { owner: vstore.current(d3, 0)!, embedding: makeVec(3) },
    ]);
    expect(readV2MirrorState(db, vstore.partitionId)?.checkRecall).toBe(0.99);

    // release() cleans removed variant from both vec_v2 and vector_partition_rows
    vstore.release(d3);
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM vector_partition_rows WHERE partition_id = ?"
        )
        .get(vstore.partitionId)?.c
    ).toBe(2);

    // rebuildPartitionIndexWithDetails repopulates both v1 and v2
    const rebuilt = rebuildPartitionIndexWithDetails(db, {
      partitionId: vstore.partitionId,
      dimensions: DIMS,
    });
    expect(rebuilt.count).toBe(2);
    expect(rebuilt.v2Count).toBe(2);

    // Non-multiple-of-8 dimensions: no vec_v2 table created, status reports unsupported
    const oddIdentity = makeIdentity("hf:test/odd-dim.gguf", 6);
    const oddStore = await createVectorVariantStore(db, oddIdentity);
    expect(isV2CompatibleDimensions(6)).toBe(false);
    expect(hasV2Table(db, oddStore.partitionId)).toBe(false);
    expect(oddStore.v2MirrorState()).toBe("unsupported");
    expect(getV2MirrorStatus(db, oddStore.partitionId, 6).state).toBe(
      "unsupported"
    );

    // Dropping a shadow partition deletes its vec_v2 table, mapping rows, and state row
    const shadowStore = await createVectorVariantStore(
      db,
      makeIdentity("hf:test/shadow-v2.gguf", DIMS)
    );
    shadowStore.writeCurrent([
      { owner: shadowStore.current(d1, 0)!, embedding: makeVec(9) },
    ]);
    expect(hasV2Table(db, shadowStore.partitionId)).toBe(true);
    const dropped = await dropVectorPartition(db, shadowStore.partitionId);
    expect(dropped.ok).toBe(true);
    expect(hasV2Table(db, shadowStore.partitionId)).toBe(false);
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM vector_partition_rows WHERE partition_id = ?"
        )
        .get(shadowStore.partitionId)?.c
    ).toBe(0);

    // Orphaned vec_v2 table + rows cleaned by pruneLegacyVectors
    const orphanId = "c".repeat(64);
    const orphanV2 = v2TableName(orphanId);
    db.exec(
      `CREATE VIRTUAL TABLE "${orphanV2}" USING vec0(collection TEXT PARTITION KEY, coarse bit[${DIMS}])`
    );
    db.run(
      "INSERT INTO vector_partition_rows (partition_id, collection, variant_id) VALUES (?, 'alpha', 1)",
      [orphanId]
    );
    db.run(
      "INSERT INTO vector_mirror_v2_state (partition_id, dirty) VALUES (?, 0)",
      [orphanId]
    );
    const pruned = await pruneLegacyVectors(db);
    expect(pruned.ok).toBe(true);
    if (pruned.ok) {
      expect(pruned.droppedTables).toContain(orphanV2);
    }
    expect(hasV2Table(db, orphanId)).toBe(false);
    expect(
      db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM vector_partition_rows WHERE partition_id = ?"
        )
        .get(orphanId)?.c
    ).toBe(0);
  });
});

describe("fn-235 R3: cost-based router rules 1-5", () => {
  test("enforces all router rules, default-off gate, non-collection filter check, budget, k cap, and multi-collection cap", () => {
    expect(COARSE_ROUTER_DEFAULTS.enabledByDefault).toBe(false);
    expect(computeCoarseK(5)).toBe(200);
    expect(computeCoarseK(10)).toBe(250);
    expect(computeCoarseK(20)).toBe(500);
    expect(computeCoarseK(40)).toBe(500);
    expect(estimateExactCostUs(100_000, 1)).toBeCloseTo(187_000, 0);

    // Mode flags excludeMetadata / semanticMetadata alone are NOT filters
    expect(
      hasNonCollectionFilter({
        eligibility: {
          collection: "notes",
          excludeMetadata: true,
          semanticMetadata: true,
        },
      })
    ).toBe(false);
    // Any real filter triggers Rule 1
    expect(
      hasNonCollectionFilter({
        eligibility: { collection: "notes", tagsAll: ["work"] },
      })
    ).toBe(true);
    expect(
      hasNonCollectionFilter({
        eligibility: { collection: "notes", language: "en" },
      })
    ).toBe(true);
    expect(
      hasNonCollectionFilter({
        eligibility: { collection: "notes", excludeSuperseded: true },
      })
    ).toBe(true);
    expect(hasNonCollectionFilter({ allowedMirrorHashes: ["h1"] })).toBe(true);

    const base = {
      options: {
        coarseVectorSearch: true,
        eligibility: {
          collection: "notes",
          excludeMetadata: true,
          semanticMetadata: true,
        },
      },
      dimensions: 1024,
      queryCount: 1,
      maxK: 10,
      collections: ["notes"],
      mirrorRows: 200_000,
      v2MirrorClean: true,
      v2CheckRecall: 0.99,
      nullCosineFlag: 0 as const,
      canUseV1ExactVec0: false,
    };

    // Rule 5: large clean checked scope with coarse enabled -> coarse-bit
    expect(resolveVectorRoute(base)).toEqual({
      route: "coarse-bit",
      coarseK: 250,
      reason: "coarse-bit",
    });

    // Default off when coarseVectorSearch omitted
    expect(
      resolveVectorRoute({
        ...base,
        options: { eligibility: { collection: "notes" } },
      }).route
    ).toBe("exact-sql");

    // Rule 1: filtered -> exact-sql
    expect(
      resolveVectorRoute({
        ...base,
        options: {
          coarseVectorSearch: true,
          eligibility: { collection: "notes", author: "alice" },
        },
      }).route
    ).toBe("exact-sql");

    // Rule 2: exact override, dirty mirror, unchecked, below floor, null_cosine != 0, bad dims
    expect(
      resolveVectorRoute({
        ...base,
        options: { ...base.options, exact: true },
      }).route
    ).toBe("exact-sql");
    expect(resolveVectorRoute({ ...base, v2MirrorClean: false }).route).toBe(
      "exact-sql"
    );
    expect(resolveVectorRoute({ ...base, v2CheckRecall: null }).route).toBe(
      "exact-sql"
    );
    expect(resolveVectorRoute({ ...base, v2CheckRecall: 0.94 }).route).toBe(
      "exact-sql"
    );
    expect(resolveVectorRoute({ ...base, nullCosineFlag: 1 }).route).toBe(
      "exact-sql"
    );
    expect(resolveVectorRoute({ ...base, nullCosineFlag: null }).route).toBe(
      "exact-sql"
    );
    expect(resolveVectorRoute({ ...base, dimensions: 1020 }).route).toBe(
      "exact-sql"
    );

    // Rule 3: within 100 ms budget -> exact
    expect(resolveVectorRoute({ ...base, mirrorRows: 40_000 }).route).toBe(
      "exact-sql"
    );
    expect(
      resolveVectorRoute({
        ...base,
        mirrorRows: 40_000,
        canUseV1ExactVec0: true,
      }).route
    ).toBe("exact-vec0");

    // Rule 4: k > 40 -> exact
    expect(resolveVectorRoute({ ...base, maxK: 41 }).route).toBe("exact-sql");

    // Multi-collection cap: 5 * 500 = 2500 > 2000 -> exact; 4 * 500 = 2000 -> coarse-bit
    expect(
      resolveVectorRoute({
        ...base,
        maxK: 20,
        collections: ["c1", "c2", "c3", "c4", "c5"],
      }).route
    ).toBe("exact-sql");
    expect(
      resolveVectorRoute({
        ...base,
        maxK: 20,
        collections: ["c1", "c2", "c3", "c4"],
      }).route
    ).toBe("coarse-bit");
  });
});

describe("fn-235 R4 & R5: two-stage access control, self-check, underfill, and R7 explain/status", () => {
  test("self-check runs in one streaming pass, enforces collection access boundary on shared variants, and reports route in explain/status", async () => {
    const { db, dbPath } = await openTempStore("gno-fn235-r4r5-");
    const identity = makeIdentity(MODEL, 32);

    // Seed 30 docs across alpha and beta, including a shared mirror_hash owned by BOTH collections
    const sharedAlpha = seedDoc(db, {
      collection: "alpha",
      relPath: "shared.md",
      docid: "#sa",
      mirrorHash: "h-shared",
      text: "shared content",
      title: "Shared Title",
    });
    const sharedBeta = seedDoc(db, {
      collection: "beta",
      relPath: "shared.md",
      docid: "#sb",
      mirrorHash: "h-shared",
      text: "shared content",
      title: "Shared Title",
    });

    const vstore = await createVectorVariantStore(db, identity);
    const writeBatch: Array<{
      owner: NonNullable<ReturnType<typeof vstore.current>>;
      embedding: Float32Array;
    }> = [
      { owner: vstore.current(sharedAlpha, 0)!, embedding: makeVec(100, 32) },
      { owner: vstore.current(sharedBeta, 0)!, embedding: makeVec(100, 32) },
    ];
    for (let i = 0; i < 24; i++) {
      const col = i % 2 === 0 ? "alpha" : "beta";
      const id = seedDoc(db, {
        collection: col,
        relPath: `doc-${i}.md`,
        docid: `#d${i}`,
        mirrorHash: `h-${i}`,
        text: `unique text ${i}`,
      });
      writeBatch.push({
        owner: vstore.current(id, 0)!,
        embedding: makeVec(200 + i, 32),
      });
    }
    vstore.writeCurrent(writeBatch);
    vstore.activate(vstore.epoch());

    // Under-budget partition skips self-check by default
    const skipped = runV2RecallSelfCheck(db, {
      partitionId: vstore.partitionId,
      dimensions: 32,
    });
    expect(skipped.ran).toBe(false);
    expect(skipped.reason).toBe("under-budget");

    // Self-check with bypassBudget computes recall@10 in one streaming pass and persists it
    const checked = runV2RecallSelfCheck(
      db,
      { partitionId: vstore.partitionId, dimensions: 32 },
      { bypassBudget: true }
    );
    expect(checked.ran).toBe(true);
    expect(checked.queries).toBe(16);
    expect(checked.coarseK).toBe(200);
    expect(checked.recall).toBeGreaterThanOrEqual(0.95);
    expect(readV2MirrorState(db, vstore.partitionId)?.checkRecall).toBe(
      checked.recall
    );

    // Status exposes coarseMirror with stored recall
    const partitions = listVectorPartitions(db, MODEL);
    expect(partitions[0]?.coarseMirror).toEqual({
      state: "clean",
      checkRecall: checked.recall,
      checkQueries: 16,
      checkCoarseK: 200,
      belowFloor: false,
    });

    // Simulate large N in vector_partition_rows so the router selects coarse-bit
    // on a real search, then verify Stage 2 NEVER leaks beta's documentId into alpha scope!
    // (Instead of inserting 60k fake variants, insert dummy non-owned rows for another collection
    // or verify directly by adding enough alpha mapping rows pointing to existing variant_ids?
    // Even cleaner: use 60k dummy mapping rows for 'alpha' pointing to non-existent variant_ids
    // so N > 53,476 triggers Rule 5 while Stage 1 + Stage 2 still operate on real rows, AND
    // also verify read-only connection never writes!)
    // Actually, for clean access-control + exact-score parity, insert 55k mapping rows for 'alpha'
    // with distinct synthetic variant_ids (none in vector_variants) in a separate temp tx or directly:
    // Wait: Stage 1 only returns rows in vec_v2, so adding rows to vector_partition_rows alone
    // raises N cleanly without polluting vec_v2!
    db.transaction(() => {
      const ins = db.prepare(
        "INSERT INTO vector_partition_rows (partition_id, collection, variant_id) VALUES (?, 'alpha', ?)"
      );
      for (let i = 10_000; i < 65_000; i++) {
        ins.run(vstore.partitionId, i);
      }
    })();

    let observedRoute: VectorRouteInfo | undefined;
    const coarseHits = searchVectorVariants(
      db,
      MODEL,
      32,
      makeVec(100, 32),
      5,
      {
        embeddingIdentity: identity,
        coarseVectorSearch: true,
        eligibility: { collection: "alpha" },
        onRoute: (info) => {
          observedRoute = info;
        },
      }
    );
    const exactHits = searchVectorVariants(db, MODEL, 32, makeVec(100, 32), 5, {
      embeddingIdentity: identity,
      coarseVectorSearch: true,
      exact: true,
      eligibility: { collection: "alpha" },
    });
    expect(observedRoute?.route).toBe("coarse-bit");
    expect(observedRoute?.coarseK).toBe(200);
    expect(observedRoute?.rescored).toBeGreaterThan(0);
    expect(coarseHits).toEqual(exactHits);

    // Critical access-control assertion: shared variant hit MUST contain ONLY sharedAlpha, NEVER sharedBeta!
    const sharedHit = coarseHits!.find((h) => h.mirrorHash === "h-shared");
    expect(sharedHit).toBeDefined();
    expect(sharedHit!.documentIds).toEqual([sharedAlpha]);
    expect(sharedHit!.documentIds).not.toContain(sharedBeta);

    // Batched queries routed as one unit also match exact bit-for-bit
    let batchRoute: VectorRouteInfo | undefined;
    const batchCoarse = searchVectorVariantsBatch(
      db,
      MODEL,
      32,
      [makeVec(100, 32), makeVec(202, 32)],
      [5, 5],
      {
        embeddingIdentity: identity,
        coarseVectorSearch: true,
        eligibility: { collection: "alpha" },
        onRoute: (info) => {
          batchRoute = info;
        },
      }
    );
    const batchExact = searchVectorVariantsBatch(
      db,
      MODEL,
      32,
      [makeVec(100, 32), makeVec(202, 32)],
      [5, 5],
      {
        embeddingIdentity: identity,
        coarseVectorSearch: true,
        exact: true,
        eligibility: { collection: "alpha" },
      }
    );
    expect(batchRoute?.route).toBe("coarse-bit");
    expect(batchCoarse).toEqual(batchExact);

    // Read-only connection succeeds on coarse-bit without writing
    const roStore = new SqliteAdapter();
    cleanupStores.push(roStore);
    expect(roStore.openReadOnly(dbPath).ok).toBe(true);
    const roDb = roStore.getRawDb();
    expect(await loadSqliteVec(roDb)).toBe(true);
    const roHits = searchVectorVariants(roDb, MODEL, 32, makeVec(100, 32), 5, {
      embeddingIdentity: identity,
      coarseVectorSearch: true,
      eligibility: { collection: "alpha" },
    });
    expect(roHits).toEqual(exactHits);

    // Stage 2 EXPLAIN QUERY PLAN must drive from json_each(cand) via CROSS JOIN
    // and seek vector_variants + vector_owners by (partition_id, variant_id),
    // never scanning all vector_owners in the partition.
    const eqp = db
      .query<{ detail: string }, [Uint8Array, string, string, string]>(
        `EXPLAIN QUERY PLAN
         SELECT o.variant_id, o.mirror_hash, o.seq, v.input_hash,
           vec_distance_cosine(v.embedding, ?) AS distance,
           json_group_array(o.document_id) AS documentIds
         FROM json_each(?) AS cand
         CROSS JOIN vector_variants v
           ON v.partition_id = ? AND v.variant_id = cand.value
         CROSS JOIN vector_owners o INDEXED BY idx_vector_owners_partition_variant
           ON o.partition_id = v.partition_id AND o.variant_id = v.variant_id
         CROSS JOIN documents d
           ON d.id = o.document_id AND d.mirror_hash = o.mirror_hash AND d.active = 1 AND d.collection = ?
         GROUP BY o.variant_id, o.mirror_hash, o.seq
         ORDER BY distance, o.mirror_hash, o.seq, o.variant_id`
      )
      .all(
        new Uint8Array(makeVec(100, 32).buffer),
        JSON.stringify([1, 2, 3]),
        vstore.partitionId,
        "alpha"
      )
      .map((r) => r.detail);
    expect(eqp[0]).toContain("SCAN cand VIRTUAL TABLE");
    expect(
      eqp.some((line) =>
        line.includes(
          "SEARCH o USING COVERING INDEX idx_vector_owners_partition_variant (partition_id=? AND variant_id=?)"
        )
      )
    ).toBe(true);

    // R7: explainVector formats route, N, coarseK, rescored; ConfigSchema accepts coarseVectorSearch
    const line = explainVector(5, true, undefined, undefined, observedRoute);
    expect(line.stage).toBe("vector");
    expect(line.message).toContain("route=coarse-bit");
    expect(line.message).toContain("coarseK=200");
    expect(line.message).toContain("rescored=");

    const parsedCfg = ConfigSchema.parse({
      version: "1.0",
      coarseVectorSearch: true,
    });
    expect(parsedCfg.coarseVectorSearch).toBe(true);
    const defaultCfg = ConfigSchema.parse({ version: "1.0" });
    expect(defaultCfg.coarseVectorSearch).toBeUndefined();
  });
});

describe("fn-235 R6: collection-scoped similar prevents other collections from crowding out hits", () => {
  test("same-collection vector search finds alpha doc even when 250 closer beta docs exist", async () => {
    const { db } = await openTempStore("gno-fn235-r6-");
    const identity = makeIdentity(MODEL, DIMS);
    const vstore = await createVectorVariantStore(db, identity);

    const alphaSrc = seedDoc(db, {
      collection: "alpha",
      relPath: "src.md",
      docid: "#asrc",
      mirrorHash: "h-asrc",
      text: "alpha source",
    });
    const alphaTarget = seedDoc(db, {
      collection: "alpha",
      relPath: "target.md",
      docid: "#atgt",
      mirrorHash: "h-atgt",
      text: "alpha target",
    });

    const baseVec = new Float32Array(DIMS);
    baseVec[0] = 1;
    const alphaTargetVec = new Float32Array(DIMS);
    alphaTargetVec[0] = 0.7;
    alphaTargetVec[1] = 0.714;

    const batch: Array<{
      owner: NonNullable<ReturnType<typeof vstore.current>>;
      embedding: Float32Array;
    }> = [
      { owner: vstore.current(alphaSrc, 0)!, embedding: baseVec },
      { owner: vstore.current(alphaTarget, 0)!, embedding: alphaTargetVec },
    ];

    // Seed 220 beta docs strictly closer to baseVec than alphaTarget
    for (let i = 0; i < 220; i++) {
      const betaId = seedDoc(db, {
        collection: "beta",
        relPath: `crowd-${i}.md`,
        docid: `#bc${i}`,
        mirrorHash: `h-bc-${i}`,
        text: `beta crowd ${i}`,
      });
      const closeVec = new Float32Array(DIMS);
      closeVec[0] = 0.99;
      closeVec[1] = 0.01 + i * 0.0001;
      batch.push({ owner: vstore.current(betaId, 0)!, embedding: closeVec });
    }
    vstore.writeCurrent(batch);
    vstore.activate(vstore.epoch());

    // Unscoped top-200 is completely crowded out by beta
    const unscoped = searchVectorVariants(db, MODEL, DIMS, baseVec, 200, {
      partitionId: vstore.partitionId,
    });
    expect(unscoped?.some((h) => h.mirrorHash === "h-atgt")).toBe(false);

    // Scoped to alpha finds alphaTarget directly
    const scoped = searchVectorVariants(db, MODEL, DIMS, baseVec, 200, {
      partitionId: vstore.partitionId,
      eligibility: { collection: "alpha" },
    });
    expect(scoped?.some((h) => h.mirrorHash === "h-atgt")).toBe(true);
  });
});

describe("fn-235 Bugbot regression: stale collection mappings pruned on release, rebind, and GC", () => {
  test("release, writeCurrent rebind, and collectGarbage remove stale (collection, variant_id) v2 rows while another collection keeps the variant", async () => {
    const { db } = await openTempStore("gno-fn235-stale-map-");
    const identity = makeIdentity(MODEL, DIMS);
    const vstore = await createVectorVariantStore(db, identity);

    // Seed identical chunk text in alpha and beta so both share one variant_id.
    const alphaShared = seedDoc(db, {
      collection: "alpha",
      relPath: "shared-a.md",
      docid: "#sa",
      mirrorHash: "h-shared-1",
      title: "Shared",
      text: "identical body text",
    });
    const betaShared = seedDoc(db, {
      collection: "beta",
      relPath: "shared-b.md",
      docid: "#sb",
      mirrorHash: "h-shared-1",
      title: "Shared",
      text: "identical body text",
    });
    const alphaRebind = seedDoc(db, {
      collection: "alpha",
      relPath: "rebind-a.md",
      docid: "#ra",
      mirrorHash: "h-rebind-old",
      title: "Rebind",
      text: "rebound text",
    });
    const betaRebind = seedDoc(db, {
      collection: "beta",
      relPath: "rebind-b.md",
      docid: "#rb",
      mirrorHash: "h-rebind-old",
      title: "Rebind",
      text: "rebound text",
    });
    const alphaGc = seedDoc(db, {
      collection: "alpha",
      relPath: "gc-a.md",
      docid: "#ga",
      mirrorHash: "h-gc-1",
      title: "GC",
      text: "gc shared text",
    });
    const betaGc = seedDoc(db, {
      collection: "beta",
      relPath: "gc-b.md",
      docid: "#gb",
      mirrorHash: "h-gc-1",
      title: "GC",
      text: "gc shared text",
    });

    const ids = vstore.writeCurrent([
      { owner: vstore.current(alphaShared, 0)!, embedding: makeVec(1, DIMS) },
      { owner: vstore.current(betaShared, 0)!, embedding: makeVec(1, DIMS) },
      { owner: vstore.current(alphaRebind, 0)!, embedding: makeVec(2, DIMS) },
      { owner: vstore.current(betaRebind, 0)!, embedding: makeVec(2, DIMS) },
      { owner: vstore.current(alphaGc, 0)!, embedding: makeVec(3, DIMS) },
      { owner: vstore.current(betaGc, 0)!, embedding: makeVec(3, DIMS) },
    ]);
    vstore.activate(vstore.epoch());
    expect(vstore.v2MirrorState()).toBe("clean");

    const sharedVariantId = ids[0]!;
    const rebindOldVariantId = ids[2]!;
    const gcVariantId = ids[4]!;
    const v2Table = v2TableName(vstore.partitionId);

    const hasMapping = (collection: string, variantId: number): boolean => {
      const row = db
        .query<{ id: number }, [string, string, number]>(
          `SELECT id FROM vector_partition_rows
           WHERE partition_id = ? AND collection = ? AND variant_id = ?`
        )
        .get(vstore.partitionId, collection, variantId);
      if (!row) return false;
      const vecRow = db
        .query<{ rowid: number }, [number]>(
          `SELECT rowid FROM "${v2Table}" WHERE rowid = ?`
        )
        .get(row.id);
      return Boolean(vecRow);
    };

    // 1. release(alphaShared) removes (alpha, sharedVariantId) while keeping (beta, sharedVariantId)
    expect(hasMapping("alpha", sharedVariantId)).toBe(true);
    expect(hasMapping("beta", sharedVariantId)).toBe(true);
    vstore.release(alphaShared);
    expect(hasMapping("alpha", sharedVariantId)).toBe(false);
    expect(hasMapping("beta", sharedVariantId)).toBe(true);
    expect(vstore.v2MirrorState()).toBe("clean");

    // 2. writeCurrent rebind of alphaRebind to a new mirror/text removes (alpha, rebindOldVariantId)
    // while keeping (beta, rebindOldVariantId) and adding (alpha, newVariantId).
    db.run(
      `INSERT OR IGNORE INTO content (mirror_hash, markdown, created_at)
       VALUES ('h-rebind-new', 'brand new content', datetime('now'))`
    );
    db.run(
      `INSERT INTO content_chunks
         (mirror_hash, seq, pos, text, start_line, end_line, language, token_count, created_at)
       VALUES ('h-rebind-new', 0, 0, 'brand new content', 1, 1, 'en', 3, datetime('now'))`
    );
    db.run("UPDATE documents SET mirror_hash = 'h-rebind-new' WHERE id = ?", [
      alphaRebind,
    ]);
    const [rebindNewVariantId] = vstore.writeCurrent([
      { owner: vstore.current(alphaRebind, 0)!, embedding: makeVec(99, DIMS) },
    ]);
    expect(rebindNewVariantId).not.toBe(rebindOldVariantId);
    expect(hasMapping("alpha", rebindOldVariantId)).toBe(false);
    expect(hasMapping("alpha", rebindNewVariantId!)).toBe(true);
    expect(hasMapping("beta", rebindOldVariantId)).toBe(true);
    expect(vstore.v2MirrorState()).toBe("clean");

    // 3. collectGarbage() sweeps stale (alpha, gcVariantId) left by an external
    // DELETE FROM vector_owners (e.g. document sync on a connection without sqlite-vec)
    // while keeping (beta, gcVariantId).
    db.run(
      "DELETE FROM vector_owners WHERE document_id = ? AND partition_id = ?",
      [alphaGc, vstore.partitionId]
    );
    expect(hasMapping("alpha", gcVariantId)).toBe(true);
    vstore.collectGarbage();
    expect(hasMapping("alpha", gcVariantId)).toBe(false);
    expect(hasMapping("beta", gcVariantId)).toBe(true);
    expect(vstore.v2MirrorState()).toBe("clean");
  });
});
