/**
 * fn-208: the stored-dimensions check behind every status build seeks an
 * index instead of scanning every vector.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrations } from "../../../src/store/migrations";
import { runMigrations } from "../../../src/store/migrations/runner";
import { getStoredEmbeddingDimensions } from "../../../src/store/vector/freshness";

function migrated(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
  return db;
}

function insertVector(
  db: Database,
  hash: string,
  model: string,
  floats: number
): void {
  db.run(
    "INSERT INTO content_vectors (mirror_hash, seq, model, embedding) VALUES (?, 0, ?, ?)",
    [hash, model, new Uint8Array(floats * 4)]
  );
}

test("each length bound is an index seek", () => {
  const db = migrated();
  try {
    for (const aggregate of ["MIN", "MAX"]) {
      const plan = db
        .query<{ detail: string }, [string]>(
          `EXPLAIN QUERY PLAN SELECT ${aggregate}(length(embedding)) AS bytes FROM content_vectors WHERE model = ?`
        )
        .all("m")
        .map((row) => row.detail)
        .join("; ");
      expect(plan).toContain("idx_vectors_model_bytes");
    }
  } finally {
    db.close();
  }
});

test("dimensions come from a uniform partition and mixed lengths are rejected", () => {
  const db = migrated();
  try {
    expect(getStoredEmbeddingDimensions(db, "m")).toBeUndefined();
    insertVector(db, "a", "m", 768);
    insertVector(db, "b", "m", 768);
    insertVector(db, "c", "other", 384);
    expect(getStoredEmbeddingDimensions(db, "m")).toBe(768);
    insertVector(db, "d", "m", 512);
    expect(getStoredEmbeddingDimensions(db, "m")).toBeUndefined();
  } finally {
    db.close();
  }
});
