/**
 * Migration: per-registration generations for receipt persistence CAS.
 *
 * Existing rows receive unique generations above the durable global epoch.
 * Future upserts allocate from that same monotonic epoch, so delete/recreate
 * cannot reuse a verification generation even for identical Capsule bytes.
 */

import type { Database } from "bun:sqlite";

import type { Migration } from "./runner";

export const migration: Migration = {
  version: 19,
  name: "saved_capsule_registration_generation",

  up(db: Database): void {
    db.exec(`
      ALTER TABLE saved_capsule_registrations
        ADD COLUMN registration_generation INTEGER NOT NULL DEFAULT 0
          CHECK (registration_generation >= 0);
    `);
    const currentEpoch =
      db
        .query<{ registration_epoch: number }, []>(
          `SELECT registration_epoch
           FROM saved_capsule_reverification_state
           WHERE singleton_id = 1`
        )
        .get()?.registration_epoch ?? 0;
    const rows = db
      .query<{ registration_id: string }, []>(
        `SELECT registration_id
         FROM saved_capsule_registrations
         ORDER BY registration_id ASC`
      )
      .all();
    const update = db.prepare(
      `UPDATE saved_capsule_registrations
       SET registration_generation = ?
       WHERE registration_id = ?`
    );
    for (const [index, row] of rows.entries()) {
      update.run(currentEpoch + index + 1, row.registration_id);
    }
    db.run(
      `UPDATE saved_capsule_reverification_state
       SET registration_epoch = ?
       WHERE singleton_id = 1`,
      [currentEpoch + rows.length]
    );
  },
};
