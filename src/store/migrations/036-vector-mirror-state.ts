/**
 * Migration: track whether each partition's vec0 mirror may be stale.
 *
 * `VectorVariantStore` keeps the vec0 mirror in step with `vector_variants`
 * in the same transaction as every write it makes, and leaves this mark as it
 * found it. Any other change to stored vectors (raw SQL, older tools, a write
 * made while sqlite-vec was unavailable) fires these triggers and removes the
 * partition's clean mark. `syncIndex()` and a verified activation mark it clean, so
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
    // A partition is clean only while it has a row with dirty = 0. Triggers
    // only delete rows, which never conflicts, so an outer statement's
    // conflict clause (UPDATE OR IGNORE, INSERT OR REPLACE) cannot cancel the
    // invalidation. The BEFORE triggers also invalidate partitions whose rows
    // a REPLACE would displace (their delete triggers do not fire unless
    // recursive_triggers is on). Each conflict is its own unique-key lookup:
    // as one OR, statistics gathered while vector_variants was small made
    // SQLite scan the table's index on every write.
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_mirror_state (
        partition_id TEXT PRIMARY KEY,
        dirty INTEGER NOT NULL CHECK (dirty IN (0, 1))
      );
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_before_insert
      BEFORE INSERT ON vector_variants BEGIN
        DELETE FROM vector_mirror_state WHERE partition_id IN (
          SELECT partition_id FROM vector_variants
          WHERE variant_id = NEW.variant_id
          UNION ALL
          SELECT partition_id FROM vector_variants
          WHERE partition_id = NEW.partition_id AND input_hash = NEW.input_hash
        );
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_insert
      AFTER INSERT ON vector_variants BEGIN
        DELETE FROM vector_mirror_state WHERE partition_id = NEW.partition_id;
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_before_update
      BEFORE UPDATE ON vector_variants BEGIN
        DELETE FROM vector_mirror_state WHERE partition_id IN (
          SELECT partition_id FROM vector_variants
          WHERE variant_id = NEW.variant_id
          UNION ALL
          SELECT partition_id FROM vector_variants
          WHERE partition_id = NEW.partition_id AND input_hash = NEW.input_hash
        );
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_update
      AFTER UPDATE ON vector_variants BEGIN
        DELETE FROM vector_mirror_state
        WHERE partition_id IN (OLD.partition_id, NEW.partition_id);
      END;
      CREATE TRIGGER IF NOT EXISTS vector_variants_mirror_delete
      AFTER DELETE ON vector_variants BEGIN
        DELETE FROM vector_mirror_state WHERE partition_id = OLD.partition_id;
      END;
    `);
  },

  down(db: Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS vector_variants_mirror_before_insert;
      DROP TRIGGER IF EXISTS vector_variants_mirror_insert;
      DROP TRIGGER IF EXISTS vector_variants_mirror_before_update;
      DROP TRIGGER IF EXISTS vector_variants_mirror_update;
      DROP TRIGGER IF EXISTS vector_variants_mirror_delete;
      DROP TABLE IF EXISTS vector_mirror_state;
    `);
  },
};
