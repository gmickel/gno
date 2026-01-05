/**
 * Migration: Document links for wiki and markdown links.
 *
 * Adds doc_links table for storing extracted links from documents.
 * Positions are 1-based line/column in ORIGINAL document (not stripped).
 *
 * @module src/store/migrations/004-doc-links
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 4,
  name: "doc_links",

  up(db: Database): void {
    // doc_links: stores extracted links from markdown documents
    // Positions are 1-based line/column in ORIGINAL document (not stripped)
    // Column values are UTF-16 code unit offsets within line (JS string indices)
    // Position range is [start, end) - end is EXCLUSIVE
    db.exec(`
      CREATE TABLE doc_links (
        id INTEGER PRIMARY KEY,
        source_doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        -- Target fields (split, not overloaded)
        target_ref TEXT NOT NULL,           -- raw path or wiki name, NO anchor
        target_ref_norm TEXT NOT NULL,      -- normalized: wiki=NFC+lower, markdown=resolved path
        target_anchor TEXT,                 -- fragment without #, nullable
        target_collection TEXT,             -- explicit prefix, NULL = same collection
        link_type TEXT NOT NULL CHECK (link_type IN ('wiki', 'markdown')),
        link_text TEXT,                     -- display text, truncated 256 graphemes, NULL if same
        -- Positions: 1-based line/col, in original document, UTF-16 code units (JS indices)
        -- Range is [start, end) - end is EXCLUSIVE
        start_line INTEGER NOT NULL,        -- 1-based line number
        start_col INTEGER NOT NULL,         -- 1-based column (UTF-16 offset in line)
        end_line INTEGER NOT NULL,          -- 1-based end line (exclusive)
        end_col INTEGER NOT NULL,           -- 1-based end column (exclusive)
        source TEXT NOT NULL DEFAULT 'parsed' CHECK (source IN ('parsed', 'user', 'suggested')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        -- Occurrence-based uniqueness (handles multiple links per line, allows different sources)
        UNIQUE(source_doc_id, start_line, start_col, link_type, source)
      )
    `);

    // Index for getLinksForDoc
    db.exec(`
      CREATE INDEX idx_doc_links_source_doc ON doc_links(source_doc_id)
    `);

    // Index for getBacklinksForDoc - wiki and markdown queries filter on link_type
    // Column order: link_type first for filtering, then target_ref_norm for equality lookups
    db.exec(`
      CREATE INDEX idx_doc_links_backlinks ON doc_links(link_type, target_ref_norm, target_collection)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_doc_links_backlinks");
    db.exec("DROP INDEX IF EXISTS idx_doc_links_source_doc");
    db.exec("DROP TABLE IF EXISTS doc_links");
  },
};
