/**
 * Migration: indexed memory scopes for managed memory records.
 *
 * Scopes are filterable inside retrieval queries (never post-hoc over a
 * bounded candidate window), so they live in their own indexed table.
 *
 * @module src/store/migrations/027-memory-scopes
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 27,
  name: "memory_scopes",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_memory_scopes (
        document_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        PRIMARY KEY (document_id, scope),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_memory_scopes_scope
      ON doc_memory_scopes(scope, document_id)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_doc_memory_scopes_scope");
    db.exec("DROP TABLE IF EXISTS doc_memory_scopes");
  },
};
