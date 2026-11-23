/**
 * Migration: persist per-partition null-cosine state on `vector_mirror_state`.
 *
 * `hasNullCosineVariant` is consulted only after `isMirrorClean` passes, so
 * storing `null_cosine` (0 = clean of null-cosine vectors, 1 = contains at
 * least one null-cosine vector, NULL = unknown) directly on the clean mirror
 * row reuses migration 036's delete-only `vector_variants` triggers with no
 * extra table or triggers. Older binaries that overwrite the row with
 * `(partition_id, dirty)` reset `null_cosine` to NULL (safe unknown fallback).
 *
 * @module src/store/migrations/038-vector-mirror-null-cosine
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 38,
  name: "vector_mirror_null_cosine",

  up(db: Database): void {
    const hasColumn = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('vector_mirror_state') WHERE name = 'null_cosine'"
      )
      .get();
    if (!hasColumn) {
      db.exec(`
        ALTER TABLE vector_mirror_state
          ADD COLUMN null_cosine INTEGER
          CHECK (null_cosine IS NULL OR null_cosine IN (0, 1));
      `);
    }
  },

  down(db: Database): void {
    const hasColumn = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('vector_mirror_state') WHERE name = 'null_cosine'"
      )
      .get();
    if (hasColumn) {
      db.exec("ALTER TABLE vector_mirror_state DROP COLUMN null_cosine;");
    }
  },
};
