/**
 * Migration: Expression indexes for graph link resolution.
 *
 * Adds indexes enabling efficient resolution of wiki and markdown links
 * when building knowledge graphs at scale.
 *
 * @module src/store/migrations/005-graph-indexes
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 5,
  name: "graph_indexes",

  up(db: Database): void {
    // Expression index for wiki link resolution
    // Matches outgoing link API semantics: lower(trim(title)) for wiki refs
    // Partial index: only active docs (no point resolving to inactive)
    db.exec(`
      CREATE INDEX idx_docs_wiki_resolve
      ON documents(collection, lower(trim(title)))
      WHERE active = 1
    `);

    // Index for markdown link resolution by rel_path
    // The UNIQUE(collection, rel_path) constraint provides an index, but
    // this partial index is faster for resolution (only active docs)
    db.exec(`
      CREATE INDEX idx_docs_md_resolve
      ON documents(collection, rel_path)
      WHERE active = 1
    `);

    // Expression index for wiki rel_path matching (uses lower(rel_path))
    db.exec(`
      CREATE INDEX idx_docs_wiki_relpath_resolve
      ON documents(collection, lower(rel_path))
      WHERE active = 1
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_docs_wiki_relpath_resolve");
    db.exec("DROP INDEX IF EXISTS idx_docs_md_resolve");
    db.exec("DROP INDEX IF EXISTS idx_docs_wiki_resolve");
  },
};
