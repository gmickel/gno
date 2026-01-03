/**
 * Migration: Document tags and ingest versioning.
 *
 * Adds ingest_version to documents for tracking schema changes.
 * Creates doc_tags table for frontmatter/user tags.
 *
 * @module src/store/migrations/003-doc-tags
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 3,
  name: "doc_tags",

  up(db: Database): void {
    // Add ingest_version to documents (default 1 for existing docs)
    db.exec(`
      ALTER TABLE documents ADD COLUMN ingest_version INTEGER DEFAULT 1
    `);

    // Create doc_tags table
    // - document_id: FK to documents.id, cascade delete
    // - tag: normalized tag text (case-insensitive via COLLATE NOCASE)
    // - source: 'frontmatter' (auto-extracted) or 'user' (manually applied)
    // - Primary key on (document_id, tag) prevents duplicates
    db.exec(`
      CREATE TABLE doc_tags (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        tag TEXT NOT NULL COLLATE NOCASE,
        source TEXT NOT NULL CHECK (source IN ('frontmatter', 'user')),
        PRIMARY KEY (document_id, tag)
      )
    `);

    // Index for tag-based queries (e.g., "find all docs with tag X")
    db.exec(`
      CREATE INDEX idx_doc_tags_tag ON doc_tags(tag)
    `);

    // Index for document lookups with source filter
    db.exec(`
      CREATE INDEX idx_doc_tags_doc_source ON doc_tags(document_id, source)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_doc_tags_doc_source");
    db.exec("DROP INDEX IF EXISTS idx_doc_tags_tag");
    db.exec("DROP TABLE IF EXISTS doc_tags");
    // Note: Cannot easily remove column in SQLite without recreating table
    // For rollback, the column will remain but be unused
  },
};
