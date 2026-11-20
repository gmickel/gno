/**
 * Migration: track whether each partition's vec0 mirror may be stale.
 *
 * `VectorVariantStore` keeps the vec0 mirror in step with `vector_variants`
 * in the same transaction as every write it makes, and leaves this mark as it
 * found it. Any other change to stored vectors (raw SQL, older tools, a write
 * made while sqlite-vec was unavailable) fires these triggers and marks the
 * partition dirty. `syncIndex()` and a verified activation mark it clean, so
 * the end of an embed pass can skip re-verifying an activated partition while
 * its mirror is known to be current, instead of scanning the whole index.
 *
 * @module src/store/migrations/036-vector-mirror-state
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 36,
  name: "vector_mirror_state",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_mirror_state (
        partition_id TEXT PRIMARY KEY,
        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1))
      );
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_insert
      AFTER INSERT ON vector_variants BEGIN
        INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty)
        VALUES (NEW.partition_id, 1);
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_update
      AFTER UPDATE ON vector_variants BEGIN
        INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty)
        VALUES (OLD.partition_id, 1);
        INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty)
        VALUES (NEW.partition_id, 1);
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_delete
      AFTER DELETE ON vector_variants BEGIN
        INSERT OR REPLACE INTO vector_mirror_state (partition_id, dirty)
        VALUES (OLD.partition_id, 1);
      END;
    `);
  },

  down(db: Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS vector_variants_mirror_insert;
      DROP TRIGGER IF EXISTS vector_variants_mirror_update;
      DROP TRIGGER IF EXISTS vector_variants_mirror_delete;
      DROP TABLE IF EXISTS vector_mirror_state;
    `);
  },
};
