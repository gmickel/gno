/**
 * Migration: drop the low-selectivity documents(active) index.
 *
 * GNO keeps no planner statistics, so SQLite treated `idx_documents_active`
 * (matching nearly every row) as a peer of selective indexes and chose it
 * for `<column> = ? AND active = 1` lookups, turning point lookups and
 * per-chunk EXISTS probes into whole-table walks. No query filters on
 * inactive documents, so the index serves no lookup.
 *
 * @module src/store/migrations/033-drop-documents-active-index
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 33,
  name: "drop_documents_active_index",

  up(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_documents_active");
  },

  down(db: Database): void {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_active ON documents(active)"
    );
  },
};
