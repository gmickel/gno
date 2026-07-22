/**
 * Migration: privacy-bounded retrieval activation receipts.
 *
 * @module src/store/migrations/012-activation-receipts
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 12,
  name: "activation_receipts",

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activation_receipts (
        collection TEXT NOT NULL,
        connector_target TEXT NOT NULL DEFAULT '',
        schema_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK (length(receipt_json) <= 16384),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (collection, connector_target),
        FOREIGN KEY (collection) REFERENCES collections(name) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activation_receipts_fingerprint
      ON activation_receipts(fingerprint)
    `);
  },

  down(db: Database): void {
    db.exec("DROP INDEX IF EXISTS idx_activation_receipts_fingerprint");
    db.exec("DROP TABLE IF EXISTS activation_receipts");
  },
};
