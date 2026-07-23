/**
 * Migration: bounded, metadata-only document change journal.
 *
 * The journal intentionally stores document identity, hashes, active state,
 * and compact structural summaries. Source and converted document bodies are
 * never copied into this table.
 *
 * @module src/store/migrations/015-document-change-journal
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 15,
  name: "document_change_journal",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE document_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL CHECK (document_id > 0),
        collection TEXT NOT NULL,
        change_kind TEXT NOT NULL
          CHECK (change_kind IN ('create', 'update', 'rename', 'inactivate', 'reactivate')),
        old_rel_path TEXT,
        new_rel_path TEXT,
        old_docid TEXT,
        new_docid TEXT,
        old_uri TEXT,
        new_uri TEXT,
        old_source_hash TEXT,
        new_source_hash TEXT,
        old_mirror_hash TEXT,
        new_mirror_hash TEXT,
        old_active INTEGER CHECK (old_active IS NULL OR old_active IN (0, 1)),
        new_active INTEGER CHECK (new_active IS NULL OR new_active IN (0, 1)),
        heading_delta_json TEXT NOT NULL DEFAULT '{"added":[],"removed":[]}',
        link_delta_json TEXT NOT NULL DEFAULT '{"added":[],"removed":[]}',
        typed_edge_delta_json TEXT NOT NULL DEFAULT '{"added":[],"removed":[]}',
        date_delta_json TEXT NOT NULL DEFAULT '{"added":[],"removed":[],"changed":[]}',
        structure_truncated INTEGER NOT NULL DEFAULT 0
          CHECK (structure_truncated IN (0, 1)),
        observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 131072),
        CHECK (length(CAST(collection AS BLOB)) BETWEEN 1 AND 256),
        CHECK (old_rel_path IS NULL OR length(CAST(old_rel_path AS BLOB)) BETWEEN 1 AND 4096),
        CHECK (new_rel_path IS NULL OR length(CAST(new_rel_path AS BLOB)) BETWEEN 1 AND 4096),
        CHECK (old_docid IS NULL OR length(CAST(old_docid AS BLOB)) BETWEEN 1 AND 256),
        CHECK (new_docid IS NULL OR length(CAST(new_docid AS BLOB)) BETWEEN 1 AND 256),
        CHECK (old_uri IS NULL OR length(CAST(old_uri AS BLOB)) BETWEEN 1 AND 8192),
        CHECK (new_uri IS NULL OR length(CAST(new_uri AS BLOB)) BETWEEN 1 AND 8192),
        CHECK (old_source_hash IS NULL OR length(CAST(old_source_hash AS BLOB)) BETWEEN 1 AND 256),
        CHECK (new_source_hash IS NULL OR length(CAST(new_source_hash AS BLOB)) BETWEEN 1 AND 256),
        CHECK (old_mirror_hash IS NULL OR length(CAST(old_mirror_hash AS BLOB)) BETWEEN 1 AND 256),
        CHECK (new_mirror_hash IS NULL OR length(CAST(new_mirror_hash AS BLOB)) BETWEEN 1 AND 256),
        CHECK (length(CAST(heading_delta_json AS BLOB)) <= 16384),
        CHECK (length(CAST(link_delta_json AS BLOB)) <= 16384),
        CHECK (length(CAST(typed_edge_delta_json AS BLOB)) <= 16384),
        CHECK (length(CAST(date_delta_json AS BLOB)) <= 16384)
      );

      CREATE INDEX idx_document_changes_collection_sequence
      ON document_changes(collection, sequence);

      CREATE INDEX idx_document_changes_document_sequence
      ON document_changes(document_id, sequence);

      CREATE INDEX idx_document_changes_retention
      ON document_changes(observed_at_ms, sequence);

      CREATE TABLE document_change_journal_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
        retention_floor INTEGER NOT NULL DEFAULT 0
          CHECK (retention_floor >= 0 AND retention_floor <= last_sequence)
      );

      INSERT INTO document_change_journal_state (
        singleton_id, last_sequence, retention_floor
      ) VALUES (1, 0, 0);
    `);
  },
};
