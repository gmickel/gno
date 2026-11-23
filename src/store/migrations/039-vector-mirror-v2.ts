/**
 * Migration 039: bit coarse vec0 mirror mapping, state table, and delete-only
 * invalidation triggers (fn-235).
 *
 * Adds:
 * - `vector_partition_rows`: stable integer rowids mapping `(partition_id, collection, variant_id)`
 *   to `vec_v2_<partitionId>` rowids.
 * - `vector_mirror_v2_state`: per-partition clean mark plus build-time recall
 *   self-check results (`check_recall`, `check_queries`, `check_coarse_k`).
 * - Delete-only triggers on `vector_variants` (I/U/D) and `vector_owners` (I/U)
 *   that write ONLY to the plain `vector_mirror_v2_state` table (never referencing
 *   any `vec0` table and never adding triggers to `documents`).
 */
import type { Database } from "bun:sqlite";

import type { Migration } from "./index";

export const migration: Migration = {
  version: 39,
  name: "vector_mirror_v2",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_partition_rows (
        id INTEGER PRIMARY KEY,
        partition_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        variant_id INTEGER NOT NULL,
        UNIQUE(partition_id, collection, variant_id)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vector_partition_rows_part_var
      ON vector_partition_rows(partition_id, variant_id)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_mirror_v2_state (
        partition_id TEXT PRIMARY KEY,
        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
        check_recall REAL,
        check_queries INTEGER,
        check_coarse_k INTEGER
      )
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vector_variants_v2_insert
      AFTER INSERT ON vector_variants
      BEGIN
        DELETE FROM vector_mirror_v2_state WHERE partition_id = NEW.partition_id;
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vector_variants_v2_update
      AFTER UPDATE ON vector_variants
      BEGIN
        DELETE FROM vector_mirror_v2_state WHERE partition_id = OLD.partition_id;
        DELETE FROM vector_mirror_v2_state WHERE partition_id = NEW.partition_id;
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vector_variants_v2_delete
      AFTER DELETE ON vector_variants
      BEGIN
        DELETE FROM vector_mirror_v2_state WHERE partition_id = OLD.partition_id;
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vector_owners_v2_insert
      AFTER INSERT ON vector_owners
      BEGIN
        DELETE FROM vector_mirror_v2_state WHERE partition_id = NEW.partition_id;
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vector_owners_v2_update
      AFTER UPDATE ON vector_owners
      BEGIN
        DELETE FROM vector_mirror_v2_state WHERE partition_id = OLD.partition_id;
        DELETE FROM vector_mirror_v2_state WHERE partition_id = NEW.partition_id;
      END
    `);
  },

  down(db: Database): void {
    db.exec("DROP TRIGGER IF EXISTS trg_vector_owners_v2_update");
    db.exec("DROP TRIGGER IF EXISTS trg_vector_owners_v2_insert");
    db.exec("DROP TRIGGER IF EXISTS trg_vector_variants_v2_delete");
    db.exec("DROP TRIGGER IF EXISTS trg_vector_variants_v2_update");
    db.exec("DROP TRIGGER IF EXISTS trg_vector_variants_v2_insert");
    db.exec("DROP TABLE IF EXISTS vector_mirror_v2_state");
    db.exec("DROP INDEX IF EXISTS idx_vector_partition_rows_part_var");
    db.exec("DROP TABLE IF EXISTS vector_partition_rows");
  },
};
