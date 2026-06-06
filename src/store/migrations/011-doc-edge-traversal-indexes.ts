/**
 * Migration: covering indexes for bounded typed-edge traversal.
 *
 * @module src/store/migrations/011-doc-edge-traversal-indexes
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 11,
  name: "doc_edge_traversal_indexes",

  up(db: Database): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_edges_src_type_dst_id
      ON doc_edges(src_doc_id, edge_type, dst_doc_id, id)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_doc_edges_dst_type_src_id
      ON doc_edges(dst_doc_id, edge_type, src_doc_id, id)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_doc_edges_dst_type_src_id");
    db.exec("DROP INDEX IF EXISTS idx_doc_edges_src_type_dst_id");
  },
};
