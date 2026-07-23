/**
 * Migration: transactional retained-row/byte counters for the change journal.
 *
 * The counters let append-time retention inspect only the oldest bounded
 * prefix that may be deleted instead of rescanning/materializing the journal.
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 17,
  name: "document_change_retention_counters",

  up(db: Database): void {
    db.exec(`
      ALTER TABLE document_change_journal_state
        ADD COLUMN retained_entries INTEGER NOT NULL DEFAULT 0
          CHECK (retained_entries >= 0);
      ALTER TABLE document_change_journal_state
        ADD COLUMN retained_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (retained_bytes >= 0);

      UPDATE document_change_journal_state
      SET retained_entries = (SELECT COUNT(*) FROM document_changes),
          retained_bytes = (
            SELECT COALESCE(SUM(byte_size), 0) FROM document_changes
          )
      WHERE singleton_id = 1;
    `);
  },
};
