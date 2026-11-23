/**
 * V2 bit coarse `vec0` mirror lifecycle and build-time recall self-check (fn-235).
 *
 * Maintains `vec_v2_<partitionId>` (`collection TEXT PARTITION KEY`, `coarse bit[dims]`),
 * `vector_partition_rows`, and `vector_mirror_v2_state` purely in SQL from
 * `vector_variants` and `vector_owners` without re-embedding and without moving
 * embedding BLOBs into JS during builds.
 *
 * @module src/store/vector/v2-mirror
 */
import type { Database } from "bun:sqlite";

import {
  COARSE_ROUTER_DEFAULTS,
  isPartitionAboveBudget,
  isV2CompatibleDimensions,
  v2TableName,
} from "./coarse-router";

export interface V2MirrorStateRow {
  dirty: number;
  checkRecall: number | null;
  checkQueries: number | null;
  checkCoarseK: number | null;
}

export interface V2MirrorStatusInfo {
  state: "clean" | "dirty" | "missing" | "unsupported";
  checkRecall: number | null;
  checkQueries: number | null;
  checkCoarseK: number | null;
  belowFloor: boolean;
}

export interface V2SyncCounts {
  added: number;
  removed: number;
  skipped?: boolean;
}

export interface V2RecallCheckResult {
  ran: boolean;
  recall: number | null;
  queries: number;
  coarseK: number;
  reason?: string;
}

export function hasV2MirrorTables(db: Database): boolean {
  const row = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('vector_partition_rows', 'vector_mirror_v2_state')`
    )
    .get();
  return (row?.c ?? 0) === 2;
}

export function hasV2Table(db: Database, partitionId: string): boolean {
  return Boolean(
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .get(v2TableName(partitionId))
  );
}

export function readV2MirrorState(
  db: Database,
  partitionId: string
): V2MirrorStateRow | null {
  if (!hasV2MirrorTables(db)) return null;
  const row = db
    .query<
      {
        dirty: number;
        check_recall: number | null;
        check_queries: number | null;
        check_coarse_k: number | null;
      },
      [string]
    >(
      `SELECT dirty, check_recall, check_queries, check_coarse_k
       FROM vector_mirror_v2_state
       WHERE partition_id = ?`
    )
    .get(partitionId);
  if (!row) return null;
  return {
    dirty: row.dirty,
    checkRecall: row.check_recall,
    checkQueries: row.check_queries,
    checkCoarseK: row.check_coarse_k,
  };
}

export function markV2MirrorClean(
  db: Database,
  partitionId: string,
  check: { recall: number; queries: number; coarseK: number } | null = null
): void {
  if (!hasV2MirrorTables(db)) return;
  db.run(
    `INSERT OR REPLACE INTO vector_mirror_v2_state
       (partition_id, dirty, check_recall, check_queries, check_coarse_k)
     VALUES (?, 0, ?, ?, ?)`,
    [
      partitionId,
      check?.recall ?? null,
      check?.queries ?? null,
      check?.coarseK ?? null,
    ]
  );
}

export function ensureV2Table(
  db: Database,
  partitionId: string,
  dimensions: number
): boolean {
  if (!isV2CompatibleDimensions(dimensions)) return false;
  const table = v2TableName(partitionId);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(
    collection TEXT PARTITION KEY,
    coarse bit[${dimensions}]
  )`);
  return true;
}

/**
 * Inspect v2 mirror freshness for a partition (parallel to v1's `mirrorState()`).
 */
export function v2MirrorFreshnessState(
  db: Database,
  partitionId: string,
  dimensions: number,
  searchAvailable: boolean
): "clean" | "dirty" | "missing" | "unsupported" {
  if (!isV2CompatibleDimensions(dimensions)) return "unsupported";
  if (!searchAvailable || !hasV2MirrorTables(db)) return "missing";
  const table = v2TableName(partitionId);
  if (!hasV2Table(db, partitionId)) return "missing";
  const state = readV2MirrorState(db, partitionId);
  if (state?.dirty !== 0) return "dirty";
  const mapped =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM vector_partition_rows WHERE partition_id = ?"
      )
      .get(partitionId)?.n ?? 0;
  const mirrored =
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()
      ?.n ?? 0;
  return mapped === mirrored ? "clean" : "dirty";
}

/**
 * Report v2 mirror status for `gno status` and `gno doctor` without loading sqlite-vec.
 */
export function getV2MirrorStatus(
  db: Database,
  partitionId: string,
  dimensions: number
): V2MirrorStatusInfo {
  if (!isV2CompatibleDimensions(dimensions)) {
    return {
      state: "unsupported",
      checkRecall: null,
      checkQueries: null,
      checkCoarseK: null,
      belowFloor: false,
    };
  }
  if (!hasV2MirrorTables(db) || !hasV2Table(db, partitionId)) {
    return {
      state: "missing",
      checkRecall: null,
      checkQueries: null,
      checkCoarseK: null,
      belowFloor: false,
    };
  }
  const state = readV2MirrorState(db, partitionId);
  const checkRecall = state?.checkRecall ?? null;
  const belowFloor =
    checkRecall !== null &&
    checkRecall < COARSE_ROUTER_DEFAULTS.selfCheckRecallFloor;
  return {
    state: state?.dirty === 0 ? "clean" : "dirty",
    checkRecall,
    checkQueries: state?.checkQueries ?? null,
    checkCoarseK: state?.checkCoarseK ?? null,
    belowFloor,
  };
}

/**
 * Incrementally sync `vector_partition_rows` and `vec_v2_<partitionId>` from
 * `vector_owners` + `vector_variants` purely in SQL (caller holds sqlite-vec
 * loaded; runs inside caller's transaction or starts an immediate tx).
 */
export function syncV2PartitionMirrorInTx(
  db: Database,
  partitionId: string,
  dimensions: number
): V2SyncCounts {
  if (!hasV2MirrorTables(db) || !isV2CompatibleDimensions(dimensions)) {
    return { added: 0, removed: 0, skipped: true };
  }
  const tableExisted = hasV2Table(db, partitionId);
  ensureV2Table(db, partitionId, dimensions);
  const table = v2TableName(partitionId);
  const prior = readV2MirrorState(db, partitionId);

  // 1. Remove mapping rows whose (collection, variant_id) is no longer owned
  // in this partition or whose variant was deleted.
  const staleRows = db
    .query<{ id: number }, [string]>(
      `SELECT r.id
       FROM vector_partition_rows r
       WHERE r.partition_id = ?
         AND (
           NOT EXISTS (
             SELECT 1 FROM vector_variants v
             WHERE v.partition_id = r.partition_id AND v.variant_id = r.variant_id
           )
           OR NOT EXISTS (
             SELECT 1 FROM vector_owners o
             JOIN documents d ON d.id = o.document_id
             WHERE o.partition_id = r.partition_id
               AND o.variant_id = r.variant_id
               AND d.collection = r.collection
           )
         )`
    )
    .all(partitionId);

  let removed = 0;
  if (staleRows.length > 0) {
    const staleIdsJson = JSON.stringify(staleRows.map((r) => r.id));
    db.query(
      `DELETE FROM "${table}" WHERE rowid IN (SELECT value FROM json_each(?))`
    ).run(staleIdsJson);
    db.query(
      `DELETE FROM vector_partition_rows WHERE id IN (SELECT value FROM json_each(?))`
    ).run(staleIdsJson);
    removed += staleRows.length;
  }

  // 2. Remove orphan rowids in vec_v2 absent from vector_partition_rows.
  const orphanVecIds = db
    .query<{ rowid: number }, [string]>(
      `SELECT x.rowid AS rowid
       FROM "${table}" x
       WHERE NOT EXISTS (
         SELECT 1 FROM vector_partition_rows r
         WHERE r.partition_id = ? AND r.id = x.rowid
       )`
    )
    .all(partitionId);
  if (orphanVecIds.length > 0) {
    db.query(
      `DELETE FROM "${table}" WHERE rowid IN (SELECT value FROM json_each(?))`
    ).run(JSON.stringify(orphanVecIds.map((r) => r.rowid)));
    removed += orphanVecIds.length;
  }

  // 3. Insert missing (collection, variant_id) pairs into vector_partition_rows.
  db.run(
    `INSERT OR IGNORE INTO vector_partition_rows (partition_id, collection, variant_id)
     SELECT DISTINCT o.partition_id, d.collection, o.variant_id
     FROM vector_owners o
     JOIN documents d ON d.id = o.document_id
     JOIN vector_variants v ON v.partition_id = o.partition_id AND v.variant_id = o.variant_id
     WHERE o.partition_id = ?`,
    [partitionId]
  );

  // 4. Materialize any mapping rows not yet present in vec_v2 purely in SQL.
  // Collect missing rowids first so the INSERT ... SELECT does not self-reference
  // the vec0 table: SQLite's Halloween-protection temp B-tree would strip
  // sqlite-vec's bit subtype from `vec_quantize_binary(v.embedding)`.
  const missingIds = db
    .query<{ id: number }, [string]>(
      `SELECT r.id
       FROM vector_partition_rows r
       WHERE r.partition_id = ?
         AND NOT EXISTS (SELECT 1 FROM "${table}" x WHERE x.rowid = r.id)`
    )
    .all(partitionId)
    .map((row) => row.id);

  if (missingIds.length > 0) {
    // Batch to keep JSON parameter bounded on very large backfills.
    const CHUNK = 50_000;
    const insertStmt = db.prepare<unknown, [string]>(
      `INSERT INTO "${table}"(rowid, collection, coarse)
       SELECT r.id, r.collection, vec_quantize_binary(v.embedding)
       FROM json_each(?) AS m
       JOIN vector_partition_rows r ON r.id = m.value
       JOIN vector_variants v
         ON v.partition_id = r.partition_id AND v.variant_id = r.variant_id`
    );
    try {
      for (let i = 0; i < missingIds.length; i += CHUNK) {
        insertStmt.run(JSON.stringify(missingIds.slice(i, i + CHUNK)));
      }
    } finally {
      insertStmt.finalize();
    }
  }
  const missingCount = missingIds.length;

  // If the mirror was previously dirty or missing, clear stored self-check so
  // the recall check re-runs on the repaired mirror; otherwise preserve it.
  const preserveCheck =
    tableExisted &&
    prior?.dirty === 0 &&
    missingCount === 0 &&
    removed === 0 &&
    prior.checkRecall !== null &&
    prior.checkQueries !== null &&
    prior.checkCoarseK !== null
      ? {
          recall: prior.checkRecall,
          queries: prior.checkQueries,
          coarseK: prior.checkCoarseK,
        }
      : null;

  markV2MirrorClean(db, partitionId, preserveCheck);
  return { added: missingCount, removed };
}

/**
 * Full drop + recreate + pure-SQL repopulation of `vec_v2_<partitionId>`.
 */
export function rebuildV2PartitionMirrorInTx(
  db: Database,
  partitionId: string,
  dimensions: number
): number {
  if (!hasV2MirrorTables(db) || !isV2CompatibleDimensions(dimensions)) {
    return 0;
  }
  const table = v2TableName(partitionId);
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
  db.run("DELETE FROM vector_partition_rows WHERE partition_id = ?", [
    partitionId,
  ]);
  ensureV2Table(db, partitionId, dimensions);

  db.run(
    `INSERT OR IGNORE INTO vector_partition_rows (partition_id, collection, variant_id)
     SELECT DISTINCT o.partition_id, d.collection, o.variant_id
     FROM vector_owners o
     JOIN documents d ON d.id = o.document_id
     JOIN vector_variants v ON v.partition_id = o.partition_id AND v.variant_id = o.variant_id
     WHERE o.partition_id = ?`,
    [partitionId]
  );

  db.run(
    `INSERT INTO "${table}"(rowid, collection, coarse)
     SELECT r.id, r.collection, vec_quantize_binary(v.embedding)
     FROM vector_partition_rows r
     JOIN vector_variants v
       ON v.partition_id = r.partition_id AND v.variant_id = r.variant_id
     WHERE r.partition_id = ?`,
    [partitionId]
  );

  const count =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM vector_partition_rows WHERE partition_id = ?"
      )
      .get(partitionId)?.n ?? 0;

  markV2MirrorClean(db, partitionId, null);
  return count;
}

/**
 * Drop v2 table, mapping rows, and state row for a partition (used by drop/re-key).
 */
export function dropV2PartitionMirrorInTx(
  db: Database,
  partitionId: string
): void {
  const table = v2TableName(partitionId);
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
  if (hasV2MirrorTables(db)) {
    db.run("DELETE FROM vector_partition_rows WHERE partition_id = ?", [
      partitionId,
    ]);
    db.run("DELETE FROM vector_mirror_v2_state WHERE partition_id = ?", [
      partitionId,
    ]);
  }
}

interface TopKHeapEntry {
  variantId: number;
  distance: number;
}

function pushTopK(
  heap: TopKHeapEntry[],
  entry: TopKHeapEntry,
  k: number
): void {
  if (heap.length < k) {
    heap.push(entry);
    if (heap.length === k) {
      heap.sort((a, b) => a.distance - b.distance || a.variantId - b.variantId);
    }
    return;
  }
  const worst = heap[k - 1]!;
  if (
    entry.distance < worst.distance ||
    (entry.distance === worst.distance && entry.variantId < worst.variantId)
  ) {
    // Insertion into small sorted array (k = 10) is faster than binary heap overhead.
    let i = k - 1;
    while (
      i > 0 &&
      (entry.distance < heap[i - 1]!.distance ||
        (entry.distance === heap[i - 1]!.distance &&
          entry.variantId < heap[i - 1]!.variantId))
    ) {
      heap[i] = heap[i - 1]!;
      i -= 1;
    }
    heap[i] = entry;
  }
}

/**
 * Build-time recall self-check (fn-235 §2 & R5).
 *
 * Samples 16 stored vectors evenly across `variant_id`, computes their exact
 * top-10 in ONE streaming SQL pass over `vector_variants` (zero embedding BLOBs
 * cross into JS during the scan), runs the same 16 through the two-stage bit
 * path at `coarseK = 200`, and persists mean recall@10 in `vector_mirror_v2_state`.
 *
 * Skips when:
 * - v2 mirror is missing, dirty, or unsupported dimensions
 * - `check_recall` is already populated (unless `force: true`)
 * - partition is within the exact-cost budget (unless `bypassBudget: true` for tests)
 * Never loads an embedding model.
 */
export function runV2RecallSelfCheck(
  db: Database,
  partition: { partitionId: string; dimensions: number },
  options: { force?: boolean; bypassBudget?: boolean } = {}
): V2RecallCheckResult {
  const { partitionId, dimensions } = partition;
  const maxQueries = COARSE_ROUTER_DEFAULTS.selfCheckQueries;
  const topK = COARSE_ROUTER_DEFAULTS.selfCheckTopK;
  const coarseK = COARSE_ROUTER_DEFAULTS.selfCheckCoarseK;

  if (
    !hasV2MirrorTables(db) ||
    !isV2CompatibleDimensions(dimensions) ||
    !hasV2Table(db, partitionId)
  ) {
    return {
      ran: false,
      recall: null,
      queries: 0,
      coarseK,
      reason: "v2-unavailable",
    };
  }

  const state = readV2MirrorState(db, partitionId);
  if (state?.dirty !== 0) {
    return { ran: false, recall: null, queries: 0, coarseK, reason: "dirty" };
  }
  if (!options.force && state.checkRecall !== null) {
    return {
      ran: false,
      recall: state.checkRecall,
      queries: state.checkQueries ?? 0,
      coarseK: state.checkCoarseK ?? coarseK,
      reason: "already-checked",
    };
  }

  const totalMirrorRows =
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM vector_partition_rows WHERE partition_id = ?"
      )
      .get(partitionId)?.n ?? 0;

  if (!options.bypassBudget && !isPartitionAboveBudget(totalMirrorRows, 1)) {
    return {
      ran: false,
      recall: null,
      queries: 0,
      coarseK,
      reason: "under-budget",
    };
  }

  // Distinct variant count in v2 mirror (we only evaluate variants present in the mirror).
  const distinctVariants =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(DISTINCT variant_id) AS n
         FROM vector_partition_rows
         WHERE partition_id = ?`
      )
      .get(partitionId)?.n ?? 0;

  if (distinctVariants === 0) {
    return { ran: false, recall: null, queries: 0, coarseK, reason: "empty" };
  }

  // Sample up to 16 stored vectors spread evenly over variant_id.
  const sampleCount = Math.min(maxQueries, distinctVariants);
  const stride = Math.max(1, Math.floor(distinctVariants / sampleCount));
  const samples: Array<{ variantId: number; blob: Uint8Array }> = [];
  const sampleStmt = db.prepare<
    { variant_id: number; embedding: Uint8Array },
    [string, number]
  >(
    `SELECT v.variant_id, v.embedding
     FROM vector_variants v
     WHERE v.partition_id = ?
       AND EXISTS (
         SELECT 1 FROM vector_partition_rows r
         WHERE r.partition_id = v.partition_id AND r.variant_id = v.variant_id
       )
     ORDER BY v.variant_id
     LIMIT 1 OFFSET ?`
  );
  for (let i = 0; i < sampleCount; i++) {
    const row = sampleStmt.get(partitionId, i * stride);
    if (!row) break;
    // Copy buffer so subsequent statement steps never alias the same backing store.
    const blob = new Uint8Array(row.embedding.byteLength);
    blob.set(row.embedding);
    samples.push({ variantId: row.variant_id, blob });
  }
  sampleStmt.finalize();

  if (samples.length === 0) {
    return { ran: false, recall: null, queries: 0, coarseK, reason: "empty" };
  }

  // Compute exact top-10 for all sampled queries in ONE streaming pass over vector_variants.
  const effectiveK = Math.min(topK, distinctVariants);
  const distanceCols = samples
    .map((_, i) => `vec_distance_cosine(v.embedding, ?) AS d${i}`)
    .join(", ");
  const streamSql = `
    SELECT v.variant_id AS variantId, ${distanceCols}
    FROM vector_variants v
    WHERE v.partition_id = ?
      AND EXISTS (
        SELECT 1 FROM vector_partition_rows r
        WHERE r.partition_id = v.partition_id AND r.variant_id = v.variant_id
      )
  `;
  const heaps: TopKHeapEntry[][] = samples.map(() => []);
  const streamStmt = db.prepare<
    Record<string, number | null>,
    (Uint8Array | string)[]
  >(streamSql);
  try {
    for (const row of streamStmt.iterate(
      ...samples.map((s) => s.blob),
      partitionId
    )) {
      const variantId = row.variantId as number;
      for (let q = 0; q < samples.length; q++) {
        const d = row[`d${q}`];
        if (d === null || d === undefined || Number.isNaN(d)) continue;
        pushTopK(heaps[q]!, { variantId, distance: d }, effectiveK);
      }
    }
  } finally {
    streamStmt.finalize();
  }

  for (const h of heaps) {
    h.sort((a, b) => a.distance - b.distance || a.variantId - b.variantId);
  }

  // Run the same sampled queries through the two-stage bit path at coarseK = 200.
  const table = v2TableName(partitionId);
  const effectiveCoarseK = Math.min(coarseK, totalMirrorRows);
  const stage1Stmt = db.prepare<{ rowid: number }, [Uint8Array, number]>(
    `SELECT rowid FROM "${table}" WHERE coarse MATCH vec_quantize_binary(?) AND k = ?`
  );
  const stage2Stmt = db.prepare<
    { variantId: number; distance: number | null },
    [string, string, Uint8Array, string, number]
  >(
    `WITH cand AS (
       SELECT DISTINCT r.variant_id AS variant_id
       FROM json_each(?) AS m
       CROSS JOIN vector_partition_rows r ON r.id = m.value
       WHERE r.partition_id = ?
     )
     SELECT v.variant_id AS variantId, vec_distance_cosine(v.embedding, ?) AS distance
     FROM cand
     CROSS JOIN vector_variants v
       ON v.partition_id = ? AND v.variant_id = cand.variant_id
     ORDER BY distance ASC NULLS LAST, v.variant_id ASC
     LIMIT ?`
  );

  let totalRecall = 0;
  let evaluated = 0;
  try {
    for (let q = 0; q < samples.length; q++) {
      const exactTop = heaps[q]!;
      if (exactTop.length === 0) continue;
      const exactSet = new Set(exactTop.map((e) => e.variantId));
      const rowids = stage1Stmt
        .all(samples[q]!.blob, effectiveCoarseK)
        .map((r) => r.rowid);
      if (rowids.length === 0) {
        evaluated += 1;
        continue;
      }
      const approxTop = stage2Stmt.all(
        JSON.stringify(rowids),
        partitionId,
        samples[q]!.blob,
        partitionId,
        effectiveK
      );
      let hits = 0;
      for (const hit of approxTop) {
        if (exactSet.has(hit.variantId)) hits += 1;
      }
      totalRecall += hits / exactSet.size;
      evaluated += 1;
    }
  } finally {
    stage1Stmt.finalize();
    stage2Stmt.finalize();
  }

  const meanRecall = evaluated > 0 ? totalRecall / evaluated : 0;

  // Persist into vector_mirror_v2_state only if the mirror is still clean.
  db.run(
    `UPDATE vector_mirror_v2_state
     SET check_recall = ?, check_queries = ?, check_coarse_k = ?
     WHERE partition_id = ? AND dirty = 0`,
    [meanRecall, evaluated, coarseK, partitionId]
  );

  return {
    ran: true,
    recall: meanRecall,
    queries: evaluated,
    coarseK,
  };
}
