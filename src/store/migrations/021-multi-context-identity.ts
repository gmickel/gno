/**
 * Migration: allow multiple distinct context records at one logical scope.
 *
 * Context resolution already treats text as part of deterministic identity.
 * The original two-column key accidentally limited each scope to one record.
 *
 * @module src/store/migrations/021-multi-context-identity
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 21,
  name: "multi_context_identity",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE contexts_v21 (
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('global', 'collection', 'prefix')),
        scope_key TEXT NOT NULL,
        text TEXT NOT NULL,
        synced_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope_type, scope_key, text)
      );

      INSERT INTO contexts_v21 (scope_type, scope_key, text, synced_at)
      SELECT scope_type, scope_key, text, synced_at
      FROM contexts;

      DROP TABLE contexts;
      ALTER TABLE contexts_v21 RENAME TO contexts;
    `);
  },
};
