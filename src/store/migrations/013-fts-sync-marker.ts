/**
 * Migration: metadata-only FTS synchronization marker.
 *
 * The marker records which mirror hash was transactionally written through the
 * supported FTS writers. This one-time migration compares legacy FTS bodies
 * before trusting them; passive activation checks remain metadata-only.
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 13,
  name: "fts_sync_marker",

  up(db: Database): void {
    db.exec("ALTER TABLE documents ADD COLUMN fts_mirror_hash TEXT");
    db.exec(`
      UPDATE documents
      SET fts_mirror_hash = mirror_hash
      WHERE active = 1
        AND mirror_hash IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM documents_fts f
          JOIN content c ON c.mirror_hash = documents.mirror_hash
          WHERE f.rowid = documents.id
            AND f.filepath = documents.rel_path
            AND f.title = COALESCE(documents.title, '')
            AND f.body = c.markdown
        )
    `);
  },

  down(db: Database): void {
    db.exec("ALTER TABLE documents DROP COLUMN fts_mirror_hash");
  },
};
