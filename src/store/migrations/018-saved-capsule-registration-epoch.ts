/**
 * Migration: saved Capsule registration epoch for race-free scheduler drains.
 *
 * Registration updates rewind the durable journal high-water mark and advance
 * this epoch in the same transaction. A scheduler drain may advance the
 * high-water mark only when no registration changed since the drain began.
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 18,
  name: "saved_capsule_registration_epoch",

  up(db: Database): void {
    db.exec(`
      ALTER TABLE saved_capsule_reverification_state
        ADD COLUMN registration_epoch INTEGER NOT NULL DEFAULT 0
          CHECK (registration_epoch >= 0);
    `);
  },
};
