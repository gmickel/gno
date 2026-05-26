/**
 * Migration: vector embedding freshness fingerprints.
 *
 * @module src/store/migrations/008-vector-fingerprints
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 8,
  name: "vector_fingerprints",

  up(db: Database): void {
    db.exec(`
      ALTER TABLE content_vectors ADD COLUMN embed_fingerprint TEXT NOT NULL DEFAULT ''
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vectors_freshness
      ON content_vectors(model, embed_fingerprint, mirror_hash, seq, embedded_at)
    `);
  },
};
