/**
 * Migration: document metadata fields for temporal/category/author filtering.
 *
 * @module src/store/migrations/006-document-metadata
 */

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 6,
  name: "document_metadata",

  up(db): void {
    db.exec(`
      ALTER TABLE documents ADD COLUMN source_ctime TEXT
    `);
    db.exec(`
      ALTER TABLE documents ADD COLUMN indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    `);
    db.exec(`
      ALTER TABLE documents ADD COLUMN content_type TEXT
    `);
    db.exec(`
      ALTER TABLE documents ADD COLUMN categories TEXT
    `);
    db.exec(`
      ALTER TABLE documents ADD COLUMN author TEXT
    `);
    db.exec(`
      ALTER TABLE documents ADD COLUMN frontmatter_date TEXT
    `);

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_source_mtime ON documents(source_mtime)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_content_type ON documents(content_type)"
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_documents_author ON documents(author)"
    );
  },

  down(db): void {
    db.exec("DROP INDEX IF EXISTS idx_documents_author");
    db.exec("DROP INDEX IF EXISTS idx_documents_content_type");
    db.exec("DROP INDEX IF EXISTS idx_documents_source_mtime");
    // SQLite cannot drop columns without table rebuild; keep columns on rollback.
  },
};
