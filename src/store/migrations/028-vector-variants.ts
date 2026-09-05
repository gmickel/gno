/** Additive exact-input variants; existing vectors have no historical proof. */
import type { Migration } from "./runner";

export const migration: Migration = {
  version: 28,
  name: "vector_variants",
  up(db): void {
    db.exec(`
      CREATE TABLE vector_variant_epoch (
        id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO vector_variant_epoch(id) VALUES (1);
      CREATE TABLE vector_partitions (
        partition_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version = 1),
        model TEXT NOT NULL, fingerprint TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        state TEXT NOT NULL DEFAULT 'shadow' CHECK (state IN ('shadow', 'active')),
        activated_epoch INTEGER,
        UNIQUE(model, fingerprint, dimensions)
      );
      CREATE TABLE vector_variants (
        variant_id INTEGER PRIMARY KEY,
        partition_id TEXT NOT NULL REFERENCES vector_partitions(partition_id),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        embedding BLOB NOT NULL,
        UNIQUE(partition_id, input_hash), UNIQUE(partition_id, variant_id)
      );
      CREATE TABLE vector_owners (
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        mirror_hash TEXT NOT NULL, seq INTEGER NOT NULL,
        partition_id TEXT NOT NULL, variant_id INTEGER NOT NULL,
        PRIMARY KEY(document_id, seq, partition_id),
        FOREIGN KEY(partition_id, variant_id)
          REFERENCES vector_variants(partition_id, variant_id)
      );
      CREATE INDEX idx_vector_owners_variant ON vector_owners(variant_id);
    `);
    // All writers, including old consumers and raw SQL, participate in the fence.
    for (const table of [
      "documents",
      "content_chunks",
      "vector_owners",
      "vector_variants",
    ]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER variant_epoch_${table}_${event}
          AFTER ${event} ON ${table} BEGIN
            UPDATE vector_variant_epoch SET epoch = epoch + 1 WHERE id = 1;
          END`);
      }
    }
  },
};
