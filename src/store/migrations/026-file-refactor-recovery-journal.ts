/**
 * Migration: bounded, metadata-only file-refactor recovery journal.
 *
 * Stores IDs, plan digests, collection/relpaths, phase/state, timestamps,
 * and fingerprints/status only. Never stores note bodies or replacements.
 * Create prunes oldest terminal receipts under FILE_REFACTOR_JOURNAL_MAX_RECEIPTS.
 *
 * @module src/store/migrations/026-file-refactor-recovery-journal
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 26,
  name: "file_refactor_recovery_journal",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_refactor_recovery_journal (
        journal_id TEXT PRIMARY KEY,
        plan_digest TEXT NOT NULL,
        collection TEXT NOT NULL,
        operation TEXT NOT NULL
          CHECK (operation IN ('rename', 'move')),
        source_rel_path TEXT NOT NULL,
        target_rel_path TEXT NOT NULL,
        phase TEXT NOT NULL
          CHECK (phase IN (
            'prepared', 'staging', 'committing', 'committed', 'sync_pending',
            'converged', 'rolling_back', 'rolled_back', 'recovery_required',
            'aborted'
          )),
        phase_ordinal INTEGER NOT NULL CHECK (phase_ordinal >= 0),
        filesystem_state TEXT NOT NULL
          CHECK (filesystem_state IN (
            'unchanged', 'committed', 'rolled_back', 'recovery_required'
          )),
        index_state TEXT NOT NULL
          CHECK (index_state IN (
            'not_attempted', 'pending', 'converged', 'skipped'
          )),
        file_entries_json TEXT NOT NULL
          CHECK (length(CAST(file_entries_json AS BLOB)) <= 65536),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        CHECK (length(CAST(journal_id AS BLOB)) BETWEEN 1 AND 128),
        CHECK (
          length(plan_digest) = 64
          AND plan_digest NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK (length(CAST(collection AS BLOB)) BETWEEN 1 AND 256),
        CHECK (length(CAST(source_rel_path AS BLOB)) BETWEEN 1 AND 4096),
        CHECK (length(CAST(target_rel_path AS BLOB)) BETWEEN 1 AND 4096),
        CHECK (updated_at_ms >= created_at_ms)
      );

      CREATE INDEX IF NOT EXISTS idx_file_refactor_journal_plan_digest
        ON file_refactor_recovery_journal(plan_digest, updated_at_ms DESC, journal_id DESC);

      CREATE INDEX IF NOT EXISTS idx_file_refactor_journal_collection
        ON file_refactor_recovery_journal(collection, updated_at_ms DESC);
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_file_refactor_journal_collection");
    db.exec("DROP INDEX IF EXISTS idx_file_refactor_journal_plan_digest");
    db.exec("DROP TABLE IF EXISTS file_refactor_recovery_journal");
  },
};
