/**
 * Migration: typed semantic document edges.
 *
 * @module src/store/migrations/010-typed-edges
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

const TABLE_INFO_DOCUMENTS = "PRAGMA table_info(documents)";

interface TableInfoRow {
  name: string;
}

function getDocumentColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>(TABLE_INFO_DOCUMENTS).all();
  return new Set(rows.map((row) => row.name));
}

export const migration: Migration = {
  version: 10,
  name: "typed_edges",

  up(db: Database): void {
    const columns = getDocumentColumns(db);
    if (!columns.has("content_type_source")) {
      db.exec("ALTER TABLE documents ADD COLUMN content_type_source TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        src_doc_id INTEGER NOT NULL,
        dst_doc_id INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('parsed', 'configured', 'manual', 'inferred')),
        source TEXT NOT NULL CHECK (source IN ('wikilink', 'markdown-link', 'frontmatter-relation')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(src_doc_id, dst_doc_id, edge_type, source),
        FOREIGN KEY (src_doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (dst_doc_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_edges_src_type
      ON doc_edges(src_doc_id, edge_type)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_edges_dst_type
      ON doc_edges(dst_doc_id, edge_type)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_content_type_source
      ON documents(content_type_source)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_documents_content_type_source");
    db.exec("DROP INDEX IF EXISTS idx_doc_edges_dst_type");
    db.exec("DROP INDEX IF EXISTS idx_doc_edges_src_type");
    // Keep table/column on rollback; SQLite column drop requires rebuild.
  },
};
