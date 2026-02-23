/**
 * Migration: document frontmatter date field map.
 *
 * @module src/store/migrations/007-document-date-fields
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 7,
  name: "document_date_fields",

  up(db: Database): void {
    db.exec(`
      ALTER TABLE documents ADD COLUMN date_fields TEXT
    `);
  },

  down(): void {
    // SQLite cannot drop columns without table rebuild; keep column on rollback.
  },
};
