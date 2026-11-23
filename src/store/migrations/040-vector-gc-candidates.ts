/**
 * Migration: queue vector variants that may have lost their last live use.
 *
 * Synchronization keeps a deactivated document's owner bindings (identical
 * restoration reuses them), so variants outlive every document that could
 * use them. These triggers record a `(partition, variant)` candidate when a
 * document goes from active to inactive, when an owner binding is deleted
 * (directly or by cascade) and when a binding is re-pointed to another
 * variant of its partition. Moving a whole partition (the one-time legacy
 * re-key keeps variant ids) is no loss: the re-key moves queued rows with
 * their timestamps. Automatic collection then examines only queued candidates, so its
 * no-op check is one indexed probe instead of a partition scan.
 *
 * `queued_at` (unix seconds) restarts whenever a variant loses a binding
 * again. Automatic collection only takes candidates older than its grace
 * period: sync keeps a deactivated document's bindings so that restoring
 * identical content costs no embedding, and a file restored within the grace
 * keeps that guarantee. `gno vec gc` ignores the grace.
 *
 * The queue has no unique key: an outer statement's conflict clause would
 * override a trigger's, so inserts skip existing rows with NOT EXISTS
 * instead. The table carries no epoch trigger; queueing never fences
 * embedding or proofs. Garbage that predates this migration and has no
 * inactive-document binding is found only by the full `gno vec gc` pass.
 *
 * @module src/store/migrations/040-vector-gc-candidates
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 40,
  name: "vector_gc_candidates",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_gc_candidates (
        partition_id TEXT NOT NULL,
        variant_id INTEGER NOT NULL,
        queued_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
      );
      CREATE INDEX IF NOT EXISTS idx_vector_gc_candidates
        ON vector_gc_candidates(partition_id, variant_id);
      CREATE INDEX IF NOT EXISTS idx_vector_gc_candidates_due
        ON vector_gc_candidates(partition_id, queued_at);
      CREATE TRIGGER IF NOT EXISTS vector_gc_owner_delete
      AFTER DELETE ON vector_owners BEGIN
        UPDATE vector_gc_candidates SET queued_at = CAST(strftime('%s', 'now') AS INTEGER)
        WHERE partition_id = OLD.partition_id AND variant_id = OLD.variant_id;
        INSERT INTO vector_gc_candidates (partition_id, variant_id)
        SELECT OLD.partition_id, OLD.variant_id
        WHERE NOT EXISTS (
          SELECT 1 FROM vector_gc_candidates
          WHERE partition_id = OLD.partition_id AND variant_id = OLD.variant_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS vector_gc_owner_rebind
      AFTER UPDATE OF variant_id ON vector_owners
      WHEN OLD.variant_id IS NOT NEW.variant_id
        AND OLD.partition_id = NEW.partition_id BEGIN
        UPDATE vector_gc_candidates SET queued_at = CAST(strftime('%s', 'now') AS INTEGER)
        WHERE partition_id = OLD.partition_id AND variant_id = OLD.variant_id;
        INSERT INTO vector_gc_candidates (partition_id, variant_id)
        SELECT OLD.partition_id, OLD.variant_id
        WHERE NOT EXISTS (
          SELECT 1 FROM vector_gc_candidates
          WHERE partition_id = OLD.partition_id AND variant_id = OLD.variant_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS vector_gc_document_inactive
      AFTER UPDATE OF active ON documents
      WHEN OLD.active = 1 AND NEW.active = 0 BEGIN
        UPDATE vector_gc_candidates SET queued_at = CAST(strftime('%s', 'now') AS INTEGER)
        WHERE rowid IN (
          SELECT q.rowid FROM vector_owners o
          JOIN vector_gc_candidates q
            ON q.partition_id = o.partition_id AND q.variant_id = o.variant_id
          WHERE o.document_id = NEW.id
        );
        INSERT INTO vector_gc_candidates (partition_id, variant_id)
        SELECT DISTINCT o.partition_id, o.variant_id
        FROM vector_owners o
        WHERE o.document_id = NEW.id
          AND NOT EXISTS (
            SELECT 1 FROM vector_gc_candidates q
            WHERE q.partition_id = o.partition_id
              AND q.variant_id = o.variant_id
          );
      END;
    `);
    // Bindings already held only by inactive documents are the common
    // existing garbage; queue them once, dated by the documents' last change
    // (deactivation sets it), so long-deactivated ones are due at once.
    db.exec(`
      INSERT INTO vector_gc_candidates (partition_id, variant_id, queued_at)
      SELECT o.partition_id, o.variant_id,
        coalesce(max(CAST(strftime('%s', d.updated_at) AS INTEGER)), CAST(strftime('%s', 'now') AS INTEGER))
      FROM documents d
      JOIN vector_owners o ON o.document_id = d.id
      WHERE d.active = 0
      GROUP BY o.partition_id, o.variant_id
    `);
  },

  down(db: Database): void {
    db.exec(`
      DROP TRIGGER IF EXISTS vector_gc_owner_delete;
      DROP TRIGGER IF EXISTS vector_gc_owner_rebind;
      DROP TRIGGER IF EXISTS vector_gc_document_inactive;
      DROP INDEX IF EXISTS idx_vector_gc_candidates_due;
      DROP INDEX IF EXISTS idx_vector_gc_candidates;
      DROP TABLE IF EXISTS vector_gc_candidates;
    `);
  },
};
