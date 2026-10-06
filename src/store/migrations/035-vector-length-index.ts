/**
 * Migration: index stored vector byte lengths per model.
 *
 * Status checks the stored embedding dimensions for the active model by
 * comparing the smallest and largest vector in its partition. Without an
 * index that is a scan of every vector on each status build (about 0.6 ms
 * per thousand vectors), run on the resident's main thread. With this
 * covering index each bound is a single index seek.
 *
 * @module src/store/migrations/035-vector-length-index
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 35,
  name: "vector_length_index",

  up(db: Database): void {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_vectors_model_bytes ON content_vectors(model, length(embedding))"
    );
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_vectors_model_bytes");
  },
};
