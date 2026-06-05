/**
 * Migration: content type rule fingerprint.
 *
 * @module src/store/migrations/009-content-type-rule-fingerprint
 */

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 9,
  name: "content_type_rule_fingerprint",

  up(db): void {
    const columns = new Set(
      db
        .query<{ name: string }, []>("PRAGMA table_info(documents)")
        .all()
        .map((row) => row.name)
    );
    if (!columns.has("content_type_rules_fingerprint")) {
      db.exec(
        "ALTER TABLE documents ADD COLUMN content_type_rules_fingerprint TEXT"
      );
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_content_type_rules_fingerprint ON documents(content_type_rules_fingerprint)"
    );
  },

  down(db): void {
    db.exec(
      "DROP INDEX IF EXISTS idx_documents_content_type_rules_fingerprint"
    );
    // SQLite cannot drop columns without a table rebuild; keep column on rollback.
  },
};
