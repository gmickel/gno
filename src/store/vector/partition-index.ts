/**
 * Maintenance of an activated vector partition's vec0 index
 * (`vec_v1_<partition>`), which mirrors the partition's `vector_variants`.
 * `gno vec sync` and `gno vec rebuild` use it on indexes embedded since 2.7.
 * Neither changes authority, owners or variants, so the variant epoch stays.
 *
 * @module src/store/vector/partition-index
 */
import type { Database } from "bun:sqlite";

export interface StoredPartition {
  partitionId: string;
  dimensions: number;
}

const tableName = (partition: StoredPartition): string =>
  `vec_v1_${partition.partitionId}`;

const createTable = (db: Database, partition: StoredPartition): void => {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName(partition)} USING vec0(
    variant_id INTEGER PRIMARY KEY,
    embedding FLOAT[${partition.dimensions}] distance_metric=cosine
  )`);
};

const insertVariants = (
  db: Database,
  partition: StoredPartition,
  rows: Iterable<{ variantId: number; embedding: Uint8Array }>
): number => {
  let inserted = 0;
  for (const row of rows) {
    db.run(
      `INSERT INTO ${tableName(partition)}(variant_id, embedding) VALUES (?, ?)`,
      [row.variantId, row.embedding]
    );
    inserted += 1;
  }
  return inserted;
};

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
      const stale = db
        .query<{ variantId: number }, [string]>(`
          SELECT x.variant_id AS variantId FROM ${table} x
          LEFT JOIN vector_variants v ON v.variant_id = x.variant_id
            AND v.partition_id = ?
          WHERE v.variant_id IS NULL OR x.embedding != v.embedding
        `)
        .all(partition.partitionId);
      for (const { variantId } of stale) {
        db.run(`DELETE FROM ${table} WHERE variant_id = ?`, [variantId]);
      }
      const missing = db
        .query<{ variantId: number; embedding: Uint8Array }, [string]>(`
          SELECT v.variant_id AS variantId, v.embedding FROM vector_variants v
          LEFT JOIN ${table} x ON x.variant_id = v.variant_id
          WHERE v.partition_id = ? AND x.variant_id IS NULL
        `)
        .all(partition.partitionId);
      return {
        added: insertVariants(db, partition, missing),
        removed: stale.length,
      };
    })
    .immediate();
}

/** Drop and repopulate the index from the partition's variants. */
export function rebuildPartitionIndex(
  db: Database,
  partition: StoredPartition
): number {
  return db
    .transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${tableName(partition)}`);
      createTable(db, partition);
      return insertVariants(
        db,
        partition,
        db
          .query<{ variantId: number; embedding: Uint8Array }, [string]>(
            "SELECT variant_id AS variantId, embedding FROM vector_variants WHERE partition_id = ?"
          )
          .iterate(partition.partitionId)
      );
    })
    .immediate();
}
