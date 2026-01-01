/**
 * Migration: Document-level FTS with Snowball stemmer.
 *
 * Replaces chunk-level content_fts with document-level documents_fts.
 * Uses snowball tokenizer for multilingual stemming support.
 *
 * @module src/store/migrations/002-documents-fts
 */

import type { Database } from 'bun:sqlite';
import type { FtsTokenizer } from '../../config/types';
import type { Migration } from './runner';

export const migration: Migration = {
  version: 2,
  name: 'documents_fts',

  up(db: Database, ftsTokenizer: FtsTokenizer): void {
    // Drop old chunk-level FTS (no backwards compat needed per epic)
    db.exec('DROP TABLE IF EXISTS content_fts');

    // Create document-level FTS with snowball stemmer
    // Indexes: filepath (for path searches), title, body (full content)
    // Note: NOT using content='' because contentless tables don't support DELETE
    // The storage overhead is acceptable for simpler update semantics
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        filepath,
        title,
        body,
        tokenize='${ftsTokenizer}'
      )
    `);
  },

  down(db: Database): void {
    db.exec('DROP TABLE IF EXISTS documents_fts');
    // Note: Cannot restore content_fts - would need full reindex
  },
};
