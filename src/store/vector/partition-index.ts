/**
 * Maintenance of an activated vector partition's vec0 index
 * (`vec_v1_<partition>`), which mirrors the partition's `vector_variants`.
 * `gno vec sync`, `gno vec rebuild`, and `gno vec prune` use it on indexes
 * embedded since 2.7. Sync/rebuild never change authority, owners, or variants,
 * so the variant epoch stays.
 *
 * @module src/store/vector/partition-index
 */
import type { Database } from "bun:sqlite";

import { modelTableName } from "./sqlite-vec";

export interface StoredPartition {
  partitionId: string;
  dimensions: number;
}

export type NullCosineMark = 0 | 1 | null;

/** True when migration 038's `null_cosine` column is present on `vector_mirror_state`. */
export function hasNullCosineColumn(db: Database): boolean {
  return Boolean(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('vector_mirror_state') WHERE name = 'null_cosine'"
      )
      .get()
  );
}

/**
 * Exact SQLite null-cosine check for one embedding BLOB. Uses sqlite-vec's own
 * float32 cosine distance so underflow/overflow vectors (e.g. components of
 * 1e-30 or 1e30) match SQLite's `vec_distance_cosine` behavior identically.
 */
export function isNullCosineEmbedding(db: Database, blob: Uint8Array): boolean {
  const row = db
    .query<{ is_null: number }, [Uint8Array]>(
      "SELECT vec_distance_cosine(?1, ?1) IS NULL AS is_null"
    )
    .get(blob);
  return row?.is_null === 1;
}

/**
 * Probe whether `partitionId` contains any variant whose cosine distance can
 * be NULL (zero or float32-norm underflow/overflow). Requires sqlite-vec.
 */
export function probePartitionNullCosine(
  db: Database,
  partitionId: string
): boolean {
  return Boolean(
    db
      .query<unknown, [string]>(
        `SELECT 1 FROM vector_variants
         WHERE partition_id = ?
           AND vec_distance_cosine(embedding, embedding) IS NULL
         LIMIT 1`
      )
      .get(partitionId)
  );
}

/**
 * Records that the partition's vec0 mirror matches its stored variants
 * (migration 036) and optionally persists its `null_cosine` state (migration
 * 038). A no-op on databases without mirror tracking. Callers run it inside
 * the transaction that made the mirror current.
 */
export function markMirrorClean(
  db: Database,
  partitionId: string,
  nullCosine: NullCosineMark = null
): void {
  if (
    !db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("vector_mirror_state")
  )
    return;
  if (hasNullCosineColumn(db)) {
    db.run(
      "INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty, null_cosine) VALUES (?, 0, ?)",
      [partitionId, nullCosine]
    );
  } else {
    db.run(
      "INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty) VALUES (?, 0)",
      [partitionId]
    );
  }
}

const tableName = (partition: StoredPartition): string =>
  `vec_v1_${partition.partitionId}`;

const createTable = (db: Database, partition: StoredPartition): void => {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(partition)} USING vec0(
    variant_id INTEGER PRIMARY KEY,
    embedding FLOAT[${partition.dimensions}] distance_metric=cosine
  )`);
};

const logicalChanges = (db: Database): number =>
  db.query<{ changes: number }, []>("SELECT changes() AS changes").get()
    ?.changes ?? 0;

/**
 * Remove index rows without a matching variant (orphans and stale
 * embeddings), then add the variants the index lacks. Requires sqlite-vec.
 */
export function syncPartitionIndex(
  db: Database,
  partition: StoredPartition
): { added: number; removed: number } {
  const table = tableName(partition);
  return db
    .transaction(() => {
      createTable(db, partition);
      db.query(
        `DELETE FROM ${table}
         WHERE variant_id IN (
           SELECT x.variant_id FROM ${table} x
           LEFT JOIN vector_variants v ON v.variant_id = x.variant_id
             AND v.partition_id = ?
           WHERE v.variant_id IS NULL OR x.embedding != v.embedding
         )`
      ).run(partition.partitionId);
      const removed = logicalChanges(db);
      db.query(
        `INSERT INTO ${table}(variant_id, embedding)
         SELECT v.variant_id, v.embedding FROM vector_variants v
         LEFT JOIN ${table} x ON x.variant_id = v.variant_id
         WHERE v.partition_id = ? AND x.variant_id IS NULL`
      ).run(partition.partitionId);
      const added = logicalChanges(db);
      const nullCosine: 0 | 1 = probePartitionNullCosine(
        db,
        partition.partitionId
      )
        ? 1
        : 0;
      markMirrorClean(db, partition.partitionId, nullCosine);
      return { added, removed };
    })
    .immediate();
}

/** Drop and repopulate the index from the partition's variants. */
export function rebuildPartitionIndex(
  db: Database,
  partition: StoredPartition
): number {
  const table = tableName(partition);
  return db
    .transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
      createTable(db, partition);
      db.query(
        `INSERT INTO ${table}(variant_id, embedding)
         SELECT variant_id, embedding FROM vector_variants WHERE partition_id = ?`
      ).run(partition.partitionId);
      const inserted = logicalChanges(db);
      const nullCosine: 0 | 1 = probePartitionNullCosine(
        db,
        partition.partitionId
      )
        ? 1
        : 0;
      markMirrorClean(db, partition.partitionId, nullCosine);
      return inserted;
    })
    .immediate();
}

export type PruneLegacyVectorsResult =
  | {
      ok: true;
      droppedTables: string[];
      removedRows: number;
      activatedModels: string[];
    }
  | { ok: false; error: string };

const VEC_V1_TABLE_PATTERN = /^vec_v1_([0-9a-f]{64})$/;

/**
 * Safely prune superseded legacy vector tables (`vec_<hash>`), legacy
 * `content_vectors` rows for models with an activated v1 partition, and
 * orphaned `vec_v1_<partition>` tables absent from `vector_partitions`.
 *
 * Requires sqlite-vec (DROP TABLE on a vec0 virtual table fails with
 * `no such module: vec0` without the extension) and a writable connection.
 */
export async function pruneLegacyVectors(
  db: Database,
  options: { loadSqliteVec?: (db: Database) => Promise<boolean> } = {}
): Promise<PruneLegacyVectorsResult> {
  const queryOnly =
    db.query<{ query_only: number }, []>("PRAGMA query_only").get()
      ?.query_only === 1;
  if (queryOnly) {
    return {
      ok: false,
      error: "Cannot prune legacy vectors on a read-only database.",
    };
  }

  let sqliteVecLoaded = false;
  if (options.loadSqliteVec) {
    sqliteVecLoaded = await options.loadSqliteVec(db);
  } else {
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(db);
      sqliteVecLoaded = true;
    } catch {
      sqliteVecLoaded = false;
    }
  }
  if (!sqliteVecLoaded) {
    return {
      ok: false,
      error:
        "sqlite-vec is unavailable; cannot drop legacy or orphaned vector tables.",
    };
  }

  try {
    return db
      .transaction((): PruneLegacyVectorsResult => {
        const hasPartitionsTable = Boolean(
          db
            .query(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
            )
            .get()
        );
        if (!hasPartitionsTable) {
          return {
            ok: true,
            droppedTables: [],
            removedRows: 0,
            activatedModels: [],
          };
        }

        const activatedModels = db
          .query<{ model: string }, []>(
            `SELECT DISTINCT model
             FROM vector_partitions
             WHERE state = 'active' AND activated_epoch IS NOT NULL
             ORDER BY model`
          )
          .all()
          .map((row) => row.model);

        const knownPartitionIds = new Set(
          db
            .query<{ partition_id: string }, []>(
              "SELECT partition_id FROM vector_partitions"
            )
            .all()
            .map((row) => row.partition_id)
        );

        const allTables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
          )
          .all()
          .map((row) => row.name);
        const tableSet = new Set(allTables);

        const droppedTables: string[] = [];
        let removedRows = 0;

        // 1. Drop legacy per-model vec_<hash> tables and delete legacy
        // content_vectors rows ONLY for models with an activated partition.
        for (const model of activatedModels) {
          const legacyTable = modelTableName(model);
          if (tableSet.has(legacyTable)) {
            db.exec(`DROP TABLE IF EXISTS "${legacyTable}"`);
            droppedTables.push(legacyTable);
          }
          if (tableSet.has("content_vectors")) {
            db.query("DELETE FROM content_vectors WHERE model = ?").run(model);
            removedRows += logicalChanges(db);
          }
        }

        // 2. Drop orphaned vec_v1_<partition> tables absent from vector_partitions.
        for (const name of allTables) {
          const match = VEC_V1_TABLE_PATTERN.exec(name);
          if (!match) continue;
          const partitionId = match[1]!;
          if (!knownPartitionIds.has(partitionId)) {
            db.exec(`DROP TABLE IF EXISTS "${name}"`);
            droppedTables.push(name);
          }
        }

        // 3. Remove orphaned rows from vector_mirror_state if present.
        if (tableSet.has("vector_mirror_state")) {
          db.run(
            `DELETE FROM vector_mirror_state
             WHERE partition_id NOT IN (SELECT partition_id FROM vector_partitions)`
          );
        }

        return {
          ok: true,
          droppedTables,
          removedRows,
          activatedModels,
        };
      })
      .immediate();
  } catch (cause) {
    return {
      ok: false,
      error: `Vector prune failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
