/**
 * Migration: document metadata fields for temporal/category/author filtering.
 *
 * @module src/store/migrations/006-document-metadata
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

function addColumnIfMissing(
  db: Database,
  columns: Set<string>,
  column: string,
  ddl: string
): void {
  if (columns.has(column)) {
    return;
  }

  db.exec(ddl);
  columns.add(column);
}

export const migration: Migration = {
  version: 6,
  name: "document_metadata",

  up(db): void {
    const columns = getDocumentColumns(db);

    addColumnIfMissing(
      db,
      columns,
      "source_ctime",
      "ALTER TABLE documents ADD COLUMN source_ctime TEXT"
    );
    // SQLite rejects non-constant defaults in ALTER TABLE on older engines.
    addColumnIfMissing(
      db,
      columns,
      "indexed_at",
      "ALTER TABLE documents ADD COLUMN indexed_at TEXT"
    );
    addColumnIfMissing(
      db,
      columns,
      "content_type",
      "ALTER TABLE documents ADD COLUMN content_type TEXT"
    );
    addColumnIfMissing(
      db,
      columns,
      "categories",
      "ALTER TABLE documents ADD COLUMN categories TEXT"
    );
    addColumnIfMissing(
      db,
      columns,
      "author",
      "ALTER TABLE documents ADD COLUMN author TEXT"
    );
    addColumnIfMissing(
      db,
      columns,
      "frontmatter_date",
      "ALTER TABLE documents ADD COLUMN frontmatter_date TEXT"
    );

    db.exec(`
      UPDATE documents
      SET indexed_at = datetime('now')
      WHERE indexed_at IS NULL
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
