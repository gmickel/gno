/** Runtime details become provenance; existing partitions await measured re-keying. */
import type { Migration } from "./runner";

export const migration: Migration = {
  version: 31,
  name: "runtime_independent_vectors",
  up(db): void {
    db.exec(`
      ALTER TABLE vector_partitions ADD COLUMN provenance TEXT;
      ALTER TABLE vector_partitions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
      -- Vector-defining key shared by a primary and its confirmed forks.
      ALTER TABLE vector_partitions ADD COLUMN base_fingerprint TEXT;
      -- Runtime fingerprint of a confirmed separate partition; NULL = primary.
      ALTER TABLE vector_partitions ADD COLUMN fork TEXT;
      UPDATE vector_partitions SET legacy = 1;
      CREATE TABLE vector_runtime_verdicts (
        partition_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        label TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('compatible', 'incompatible')),
        min_cosine REAL NOT NULL,
        samples INTEGER NOT NULL CHECK (samples >= 0),
        sample_ms REAL NOT NULL,
        PRIMARY KEY (partition_id, runtime)
      );
    `);
  },
};
