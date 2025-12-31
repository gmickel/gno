/**
 * sqlite-vec adapter for vector search acceleration.
 * Per-model vec tables to avoid dimension/collision issues.
 *
 * @module src/store/vector/sqliteVec
 */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { StoreResult } from '../types';
import { err, ok } from '../types';
import type { VectorIndexPort, VectorRow, VectorSearchResult } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// BLOB Encoding Helpers (avoid Buffer.buffer footgun)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode Float32Array to Uint8Array for SQLite BLOB storage.
 * Creates a copy to avoid shared ArrayBuffer issues.
 */
export function encodeEmbedding(f32: Float32Array): Uint8Array {
  return new Uint8Array(
    f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength)
  );
}

/**
 * Decode Uint8Array from SQLite BLOB to Float32Array.
 * Creates a copy to avoid shared ArrayBuffer issues.
 * @throws Error if blob length is not aligned to 4 bytes
 */
export function decodeEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(
      `Invalid embedding blob: length ${blob.byteLength} is not aligned to 4 bytes`
    );
  }
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate deterministic table name from model URI.
 * First 8 chars of SHA256 hash.
 */
function modelTableName(modelUri: string): string {
  const hash = createHash('sha256').update(modelUri).digest('hex').slice(0, 8);
  return `vec_${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export interface VectorIndexOptions {
  model: string;
  dimensions: number;
  distanceMetric?: 'cosine' | 'l2';
}

/**
 * Create a VectorIndexPort for a specific model.
 * sqlite-vec is optional - storage works without it, search disabled.
 */
export async function createVectorIndexPort(
  db: Database,
  options: VectorIndexOptions
): Promise<StoreResult<VectorIndexPort>> {
  const { model, dimensions, distanceMetric = 'cosine' } = options;
  const tableName = modelTableName(model);

  // Try loading sqlite-vec extension (ESM dynamic import)
  let searchAvailable = false;
  let loadError: string | undefined;
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db);
    searchAvailable = true;
  } catch (e) {
    // sqlite-vec not available - storage still works, search disabled
    loadError = e instanceof Error ? e.message : String(e);
  }

  // Create per-model vec0 table if extension available
  // Graceful degradation: if table creation fails, storage still works
  if (searchAvailable) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding FLOAT[${dimensions}] distance_metric=${distanceMetric}
        );
      `);
    } catch (e) {
      // Vec table creation failed - degrade to storage-only mode
      searchAvailable = false;
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  // Prepared statements for content_vectors table
  const upsertVectorStmt = db.prepare(`
    INSERT OR REPLACE INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const deleteVectorStmt = db.prepare(`
    DELETE FROM content_vectors WHERE mirror_hash = ? AND model = ?
  `);

  // Prepared statements for vec0 table (if available)
  const upsertVecStmt = searchAvailable
    ? db.prepare(
        `INSERT OR REPLACE INTO ${tableName} (chunk_id, embedding) VALUES (?, ?)`
      )
    : null;

  const searchStmt = searchAvailable
    ? db.prepare(`
        SELECT chunk_id, distance
        FROM ${tableName}
        WHERE embedding MATCH ?
          AND k = ?
      `)
    : null;

  const deleteVecStmt = searchAvailable
    ? db.prepare(`DELETE FROM ${tableName} WHERE chunk_id LIKE ? || ':%'`)
    : null;

  return ok({
    searchAvailable,
    model,
    dimensions,
    loadError,

    upsertVectors(rows: VectorRow[]): Promise<StoreResult<void>> {
      // 1. Always store in content_vectors first (critical path)
      try {
        db.transaction(() => {
          for (const row of rows) {
            upsertVectorStmt.run(
              row.mirrorHash,
              row.seq,
              row.model,
              encodeEmbedding(row.embedding)
            );
          }
        })();
      } catch (e) {
        return Promise.resolve(
          err(
            'VECTOR_WRITE_FAILED',
            `Vector write failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }

      // 2. Best-effort update vec0 (graceful degradation)
      if (upsertVecStmt) {
        try {
          db.transaction(() => {
            for (const row of rows) {
              const chunkId = `${row.mirrorHash}:${row.seq}`;
              upsertVecStmt.run(chunkId, encodeEmbedding(row.embedding));
            }
          })();
        } catch {
          // Vec0 write failed - storage succeeded, search may be degraded
          // This is expected when dimensions mismatch or vec extension issues
        }
      }

      return Promise.resolve(ok(undefined));
    },

    deleteVectorsForMirror(mirrorHash: string): Promise<StoreResult<void>> {
      // 1. Always delete from content_vectors first
      try {
        deleteVectorStmt.run(mirrorHash, model);
      } catch (e) {
        return Promise.resolve(
          err(
            'VECTOR_DELETE_FAILED',
            `Vector delete failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }

      // 2. Best-effort delete from vec0
      if (deleteVecStmt) {
        try {
          deleteVecStmt.run(mirrorHash);
        } catch {
          // Vec0 delete failed - not critical
        }
      }

      return Promise.resolve(ok(undefined));
    },

    searchNearest(
      embedding: Float32Array,
      k: number,
      searchOptions?: { minScore?: number }
    ): Promise<StoreResult<VectorSearchResult[]>> {
      if (!(searchAvailable && searchStmt)) {
        return Promise.resolve(
          err(
            'VEC_SEARCH_UNAVAILABLE',
            'Vector search requires sqlite-vec. Embeddings stored but KNN search disabled.'
          )
        );
      }

      try {
        const results = searchStmt.all(encodeEmbedding(embedding), k) as {
          chunk_id: string;
          distance: number;
        }[];

        // Filter by minScore if provided
        // For cosine distance: similarity = 1 - distance, keep if >= minScore
        const minScore = searchOptions?.minScore;
        const filtered =
          minScore !== undefined
            ? results.filter((r) => 1 - r.distance >= minScore)
            : results;

        return Promise.resolve(
          ok(
            filtered.map((r) => {
              const parts = r.chunk_id.split(':');
              const mirrorHash = parts[0] ?? '';
              const seqStr = parts[1] ?? '0';
              return {
                mirrorHash,
                seq: Number.parseInt(seqStr, 10),
                distance: r.distance,
              };
            })
          )
        );
      } catch (e) {
        return Promise.resolve(
          err(
            'VEC_SEARCH_FAILED',
            `Vector search failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    rebuildVecIndex(): Promise<StoreResult<void>> {
      if (!searchAvailable) {
        return Promise.resolve(ok(undefined)); // No-op if no vec support
      }

      try {
        // Drop and recreate vec table from content_vectors
        db.exec(`DROP TABLE IF EXISTS ${tableName}`);
        db.exec(`
          CREATE VIRTUAL TABLE ${tableName} USING vec0(
            chunk_id TEXT PRIMARY KEY,
            embedding FLOAT[${dimensions}] distance_metric=${distanceMetric}
          );
        `);

        // Repopulate from content_vectors
        const rows = db
          .prepare(
            'SELECT mirror_hash, seq, embedding FROM content_vectors WHERE model = ?'
          )
          .all(model) as {
          mirror_hash: string;
          seq: number;
          embedding: Uint8Array;
        }[];

        const insertStmt = db.prepare(`
          INSERT INTO ${tableName} (chunk_id, embedding) VALUES (?, ?)
        `);

        db.transaction(() => {
          for (const row of rows) {
            const chunkId = `${row.mirror_hash}:${row.seq}`;
            insertStmt.run(chunkId, row.embedding);
          }
        })();

        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(
          err(
            'VEC_REBUILD_FAILED',
            `Vec rebuild failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    syncVecIndex(): Promise<StoreResult<{ added: number; removed: number }>> {
      if (!searchAvailable) {
        return Promise.resolve(ok({ added: 0, removed: 0 }));
      }

      try {
        let added = 0;
        let removed = 0;

        // 1. Remove orphans from vec table (not in content_vectors for this model)
        const orphanResult = db
          .prepare(
            `
            DELETE FROM ${tableName}
            WHERE chunk_id NOT IN (
              SELECT mirror_hash || ':' || seq
              FROM content_vectors
              WHERE model = ?
            )
          `
          )
          .run(model);
        removed = orphanResult.changes;

        // 2. Add missing entries (in content_vectors but not in vec table)
        const missing = db
          .prepare(
            `
            SELECT cv.mirror_hash, cv.seq, cv.embedding
            FROM content_vectors cv
            WHERE cv.model = ?
              AND (cv.mirror_hash || ':' || cv.seq) NOT IN (
                SELECT chunk_id FROM ${tableName}
              )
          `
          )
          .all(model) as {
          mirror_hash: string;
          seq: number;
          embedding: Uint8Array;
        }[];

        if (missing.length > 0) {
          const insertStmt = db.prepare(`
            INSERT INTO ${tableName} (chunk_id, embedding) VALUES (?, ?)
          `);
          db.transaction(() => {
            for (const row of missing) {
              const chunkId = `${row.mirror_hash}:${row.seq}`;
              insertStmt.run(chunkId, row.embedding);
            }
          })();
          added = missing.length;
        }

        return Promise.resolve(ok({ added, removed }));
      } catch (e) {
        return Promise.resolve(
          err(
            'VEC_SYNC_FAILED',
            `Vec sync failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },
  });
}
