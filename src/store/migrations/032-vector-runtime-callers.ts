/** Identity each caller (process runtime + env) last resolved, for status. */
import type { Migration } from "./runner";

export const migration: Migration = {
  version: 32,
  name: "vector_runtime_callers",
  up(db): void {
    db.exec(`
      CREATE TABLE vector_runtime_callers (
        caller TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        label TEXT NOT NULL,
        identity TEXT NOT NULL
      );
    `);
  },
};
