/**
 * sqlite-vec adapter for vector search acceleration.
 * Per-model vec tables to avoid dimension/collision issues.
 *
 * @module src/store/vector/sqliteVec
 */

import type { Database } from "bun:sqlite";

import { createHash } from "node:crypto";

import type { StoreResult } from "../types";
import type {
  VectorIndexPort,
  VectorRow,
  VectorSearchOptions,
  VectorSearchResult,
} from "./types";

import { err, ok } from "../types";
import { buildEligibleVectorChunksQuery } from "./eligibility";
import {
  searchVectorVariants,
  searchVectorVariantsBatch,
} from "./variant-search";

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
export function modelTableName(modelUri: string): string {
  const hash = createHash("sha256").update(modelUri).digest("hex").slice(0, 8);
  return `vec_${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

const indexDatabases = new WeakMap<VectorIndexPort, Database>();
/** Query-only read connections, mapped to the shared connection that writes. */
const writerDatabases = new WeakMap<
  Database,
  { writer: Database; idle: () => Promise<void> }
>();

/**
 * Register `reader` as a query-only connection whose writes go to `writer`;
 * `idle` resolves once no write transaction is open on `writer`.
 */
export function bindReadConnection(
  reader: Database,
  writer: Database,
  idle: () => Promise<void>
): void {
  writerDatabases.set(reader, { writer, idle });
}

/**
 * The connection to write on for `db`: itself, or for a query-only read
 * connection, the shared connection behind it. Partition resolution records
 * runtime callers and migrates legacy partitions, so it runs there.
 */
export function writerConnection(db: Database): Database {
  return writerDatabases.get(db)?.writer ?? db;
}

/** Wait until the shared connection behind `db` has committed its open batch. */
export function writerIdle(db: Database): Promise<void> {
  return writerDatabases.get(db)?.idle() ?? Promise.resolve();
}

/** Partition resolution needs the database behind a vector index port. */
export function getVectorIndexDatabase(
  port: VectorIndexPort
): Database | undefined {
  return indexDatabases.get(port);
}

export function bindVectorIndexDatabase<T extends VectorIndexPort>(
  port: T,
  db: Database
): T {
  indexDatabases.set(port, db);
  return port;
}

export interface VectorIndexOptions {
  model: string;
  dimensions: number;
  distanceMetric?: "cosine" | "l2";
}

const SQLITE_VEC_GUIDANCE =
  "Run `gno doctor` for sqlite-vec diagnostics. On macOS, verify Homebrew SQLite/sqlite-vec installation and see TROUBLESHOOTING.md.";

function formatUnavailableMessage(loadError?: string): string {
  const reason = loadError ? ` Reason: ${loadError}` : "";
  return `Vector search requires sqlite-vec. Embeddings are stored, but KNN search is disabled.${reason} ${SQLITE_VEC_GUIDANCE}`;
}

const ALLOWED_HASH_BATCH_SIZE = 800;

const compareVectorResults = (
  left: VectorSearchResult,
  right: VectorSearchResult
): number =>
  left.distance - right.distance ||
  left.mirrorHash.localeCompare(right.mirrorHash) ||
  left.seq - right.seq;

/**
 * Create a VectorIndexPort for a specific model.
 * sqlite-vec is optional - storage works without it, search disabled.
 */
export async function createVectorIndexPort(
  db: Database,
  options: VectorIndexOptions
): Promise<StoreResult<VectorIndexPort>> {
  const { model, dimensions, distanceMetric = "cosine" } = options;
  const tableName = modelTableName(model);

  // Try loading sqlite-vec extension (ESM dynamic import)
  let searchAvailable = false;
  let loadError: string | undefined;
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    searchAvailable = true;
  } catch (e) {
    // sqlite-vec not available - storage still works, search disabled
    loadError = e instanceof Error ? e.message : String(e);
  }

  // A query-only (read) connection cannot create the table. A missing table
  // there means no vectors were ever stored for this model: search is empty.
  // Once a v1 partition is active for this model, never create an unused legacy
  // vec_<hash> table; variant search runs through vec_v1_<partition> instead.
  const tableExists =
    db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM sqlite_master WHERE name = ?"
      )
      .get(tableName) !== null;
  const queryOnly =
    db.query<{ query_only: number }, []>("PRAGMA query_only").get()
      ?.query_only === 1;
  const hasActivatedPartition =
    db
      .query<{ found: number }, []>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
      )
      .get() !== null &&
    db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM vector_partitions WHERE model = ? AND state = 'active' AND activated_epoch IS NOT NULL LIMIT 1"
      )
      .get(model) !== null;
  const noVectorsYet = searchAvailable && !tableExists && queryOnly;
  const partitionActiveNoLegacy =
    searchAvailable && !tableExists && hasActivatedPartition;

  // Create per-model vec0 table if extension available and no v1 partition is active
  // Graceful degradation: if table creation fails, storage still works
  if (searchAvailable && !tableExists && !queryOnly && !hasActivatedPartition) {
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
    INSERT OR REPLACE INTO content_vectors (
      mirror_hash, seq, model, embed_fingerprint, embedding, embedded_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  const deleteVectorStmt = db.prepare(`
    DELETE FROM content_vectors WHERE mirror_hash = ? AND model = ?
  `);

  // Prepared statements for vec0 table (if available and legacy table exists)
  const hasLegacyVecTable =
    searchAvailable && !noVectorsYet && !partitionActiveNoLegacy;
  const deleteVecChunkStmt = hasLegacyVecTable
    ? db.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`)
    : null;

  const insertVecStmt = hasLegacyVecTable
    ? db.prepare(`INSERT INTO ${tableName} (chunk_id, embedding) VALUES (?, ?)`)
    : null;

  const searchStmt = hasLegacyVecTable
    ? db.prepare(`
        SELECT chunk_id, distance
        FROM ${tableName}
        WHERE embedding MATCH ?
          AND k = ?
      `)
    : null;

  const deleteVecStmt = hasLegacyVecTable
    ? db.prepare(`DELETE FROM ${tableName} WHERE chunk_id LIKE ? || ':%'`)
    : null;

  // Track if vec0 writes failed this session (needs sync)
  let vecDirty = false;
  let vecErrorLogged = false; // Rate-limit warning to once per run

  function upsert(
    rows: VectorRow[],
    checkpoint?: (rows: VectorRow[]) => VectorRow[]
  ): Promise<StoreResult<number>> {
    // Combine content_vectors write and best-effort vec0 update into one
    // outer transaction; a SAVEPOINT isolates vec0 failures so committed
    // content_vectors rows are preserved identically.
    try {
      const count = db.transaction(() => {
        rows = checkpoint?.(rows) ?? rows;
        const encoded = rows.map(
          (row) =>
            new Uint8Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength
            )
        );
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          upsertVectorStmt.run(
            row.mirrorHash,
            row.seq,
            row.model,
            row.embedFingerprint,
            encoded[i]!
          );
        }

        if (deleteVecChunkStmt && insertVecStmt && rows.length > 0) {
          db.exec("SAVEPOINT vec0_upsert");
          try {
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i]!;
              const chunkId = `${row.mirrorHash}:${row.seq}`;
              // sqlite-vec vec0 tables do not reliably support OR REPLACE semantics.
              // Delete first, then insert the fresh vector row.
              deleteVecChunkStmt.run(chunkId);
              insertVecStmt.run(chunkId, encoded[i]!);
            }
            db.exec("RELEASE SAVEPOINT vec0_upsert");
          } catch (e) {
            db.exec("ROLLBACK TO SAVEPOINT vec0_upsert");
            db.exec("RELEASE SAVEPOINT vec0_upsert");
            // Vec0 write failed - storage succeeded, search needs sync
            vecDirty = true;
            if (!vecErrorLogged) {
              vecErrorLogged = true;
              console.warn(
                `[vec] Index write failed, will sync after embed: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        }
        return rows.length;
      })();
      return Promise.resolve(ok(count));
    } catch (e) {
      return Promise.resolve(
        err(
          "VECTOR_WRITE_FAILED",
          `Vector write failed: ${e instanceof Error ? e.message : String(e)}`,
          e
        )
      );
    }
  }

  const port: VectorIndexPort = {
    searchAvailable,
    model,
    dimensions,
    loadError,
    guidance: searchAvailable ? undefined : SQLITE_VEC_GUIDANCE,
    get vecDirty() {
      return vecDirty;
    },
    set vecDirty(v: boolean) {
      vecDirty = v;
    },

    upsertVectors(rows) {
      return upsert(rows).then((result) =>
        result.ok ? ok(undefined) : result
      );
    },
    upsertVectorsChecked: upsert,

    deleteVectorsForMirror(mirrorHash: string): Promise<StoreResult<void>> {
      // 1. Always delete from content_vectors first
      try {
        deleteVectorStmt.run(mirrorHash, model);
      } catch (e) {
        return Promise.resolve(
          err(
            "VECTOR_DELETE_FAILED",
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
      searchOptions?: VectorSearchOptions
    ): Promise<StoreResult<VectorSearchResult[]>> {
      if (
        !searchAvailable ||
        !(searchStmt || noVectorsYet || partitionActiveNoLegacy)
      ) {
        return Promise.resolve(
          err("VEC_SEARCH_UNAVAILABLE", formatUnavailableMessage(loadError))
        );
      }
      if (!Number.isSafeInteger(k) || k < 1) {
        return Promise.resolve(
          err("INVALID_INPUT", "Vector search limit must be a positive integer")
        );
      }

      try {
        const variants = searchVectorVariants(
          db,
          model,
          dimensions,
          embedding,
          k,
          searchOptions
        );
        if (variants !== null) return Promise.resolve(ok(variants));
        if (searchOptions?.eligibility) {
          const eligible = buildEligibleVectorChunksQuery(db, searchOptions);
          const distanceFunction =
            distanceMetric === "cosine"
              ? "vec_distance_cosine"
              : "vec_distance_L2";
          const rows = db
            .query<
              { mirrorHash: string; seq: number; distance: number },
              (Uint8Array | string | number)[]
            >(`
            SELECT v.mirror_hash AS mirrorHash, v.seq,
              ${distanceFunction}(v.embedding, ?) AS distance
            FROM (
              ${eligible.sql}
            ) e
            JOIN content_vectors v
              ON v.mirror_hash = e.mirror_hash
              AND v.seq = e.seq
              AND v.model = ?
            ORDER BY distance, v.mirror_hash, v.seq LIMIT ?
          `)
            .all(encodeEmbedding(embedding), ...eligible.params, model, k);
          return Promise.resolve(
            ok(
              rows.filter(
                (row) =>
                  searchOptions.minScore === undefined ||
                  1 - row.distance >= searchOptions.minScore
              )
            )
          );
        }
        const allowed = searchOptions?.allowedMirrorHashes;
        if (allowed) {
          const hashes = [
            ...new Set(allowed.filter((hash) => hash.length > 0)),
          ].sort();
          if (hashes.length === 0) return Promise.resolve(ok([]));
          const distanceFunction =
            distanceMetric === "cosine"
              ? "vec_distance_cosine"
              : "vec_distance_L2";
          const queryVector = encodeEmbedding(embedding);
          const scopedStmt = db.query<
            {
              mirror_hash: string;
              seq: number;
              distance: number;
            },
            [Uint8Array, string, string, number]
          >(
            `SELECT mirror_hash, seq,
                    ${distanceFunction}(embedding, ?) AS distance
             FROM content_vectors
             WHERE model = ?
               AND mirror_hash IN (SELECT value FROM json_each(?))
             ORDER BY distance, mirror_hash, seq
             LIMIT ?`
          );
          const rows = scopedStmt.all(
            queryVector,
            model,
            JSON.stringify(hashes),
            k
          );
          const minScore = searchOptions.minScore;
          // SQLite sorts NULL distances (e.g. zero vectors under cosine) first.
          // When hashes span multiple legacy batches and a NULL distance appears
          // in the top-k, preserve exact per-batch SQL selection + JS merge order.
          if (
            hashes.length > ALLOWED_HASH_BATCH_SIZE &&
            rows.length > 0 &&
            rows[0]!.distance === null
          ) {
            const scoped: VectorSearchResult[] = [];
            for (
              let index = 0;
              index < hashes.length;
              index += ALLOWED_HASH_BATCH_SIZE
            ) {
              const batch = hashes.slice(
                index,
                index + ALLOWED_HASH_BATCH_SIZE
              );
              const batchRows = scopedStmt.all(
                queryVector,
                model,
                JSON.stringify(batch),
                k
              );
              scoped.push(
                ...batchRows.map((row) => ({
                  mirrorHash: row.mirror_hash,
                  seq: row.seq,
                  distance: row.distance,
                }))
              );
            }
            return Promise.resolve(
              ok(
                scoped
                  .sort(compareVectorResults)
                  .filter(
                    (row) =>
                      minScore === undefined || 1 - row.distance >= minScore
                  )
                  .slice(0, k)
              )
            );
          }
          return Promise.resolve(
            ok(
              rows
                .map((row) => ({
                  mirrorHash: row.mirror_hash,
                  seq: row.seq,
                  distance: row.distance,
                }))
                .sort(compareVectorResults)
                .filter(
                  (row) =>
                    minScore === undefined || 1 - row.distance >= minScore
                )
            )
          );
        }
        // No per-model table on a read connection: nothing was ever stored.
        if (!searchStmt) return Promise.resolve(ok([]));
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
              const parts = r.chunk_id.split(":");
              const mirrorHash = parts[0] ?? "";
              const seqStr = parts[1] ?? "0";
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
            "VEC_SEARCH_FAILED",
            `Vector search failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    async searchNearestBatch(
      embeddings: Float32Array[],
      limits: number[],
      searchOptions?: VectorSearchOptions
    ): Promise<StoreResult<VectorSearchResult[][]>> {
      if (
        !searchAvailable ||
        !(searchStmt || noVectorsYet || partitionActiveNoLegacy)
      ) {
        return err(
          "VEC_SEARCH_UNAVAILABLE",
          formatUnavailableMessage(loadError)
        );
      }
      if (embeddings.length !== limits.length) {
        return err(
          "INVALID_INPUT",
          "Vector batch search embeddings and limits must have equal length"
        );
      }
      for (const k of limits) {
        if (!Number.isSafeInteger(k) || k < 1) {
          return err(
            "INVALID_INPUT",
            "Vector search limit must be a positive integer"
          );
        }
      }
      if (embeddings.length === 0) {
        return ok([]);
      }
      if (embeddings.length === 1) {
        const single = await port.searchNearest(
          embeddings[0]!,
          limits[0]!,
          searchOptions
        );
        return single.ok ? ok([single.value]) : single;
      }

      try {
        const batch = searchVectorVariantsBatch(
          db,
          model,
          dimensions,
          embeddings,
          limits,
          searchOptions
        );
        if (batch !== null) return ok(batch);
      } catch (e) {
        return err(
          "VEC_SEARCH_FAILED",
          `Vector search failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      const legacyResults: VectorSearchResult[][] = [];
      for (let i = 0; i < embeddings.length; i++) {
        const single = await port.searchNearest(
          embeddings[i]!,
          limits[i]!,
          searchOptions
        );
        if (!single.ok) return single;
        legacyResults.push(single.value);
      }
      return ok(legacyResults);
    },

    rebuildVecIndex(): Promise<StoreResult<void>> {
      if (!searchAvailable || partitionActiveNoLegacy) {
        return Promise.resolve(ok(undefined)); // No-op if no vec support or v1 active without legacy table
      }

      try {
        // Drop, recreate, and repopulate vec table in pure SQL inside one transaction
        db.transaction(() => {
          db.exec(`DROP TABLE IF EXISTS ${tableName}`);
          db.exec(`
            CREATE VIRTUAL TABLE ${tableName} USING vec0(
              chunk_id TEXT PRIMARY KEY,
              embedding FLOAT[${dimensions}] distance_metric=${distanceMetric}
            );
          `);
          db.query(
            `INSERT INTO ${tableName} (chunk_id, embedding)
             SELECT mirror_hash || ':' || seq, embedding
             FROM content_vectors
             WHERE model = ?`
          ).run(model);
        })();

        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(
          err(
            "VEC_REBUILD_FAILED",
            `Vec rebuild failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },

    syncVecIndex(): Promise<StoreResult<{ added: number; removed: number }>> {
      if (!searchAvailable || partitionActiveNoLegacy) {
        return Promise.resolve(ok({ added: 0, removed: 0 }));
      }

      try {
        // Wrap entire sync in transaction for atomicity, pure SQL without pulling BLOBs into JS
        const result = db.transaction(() => {
          // 1. Remove orphans from vec table (not in content_vectors for this model)
          db.query(
            `DELETE FROM ${tableName}
             WHERE chunk_id NOT IN (
               SELECT mirror_hash || ':' || seq
               FROM content_vectors
               WHERE model = ?
             )`
          ).run(model);
          const removed =
            db.query<{ c: number }, []>("SELECT changes() AS c").get()?.c ?? 0;

          // 2. Add missing entries (in content_vectors but not in vec table)
          db.query(
            `INSERT INTO ${tableName} (chunk_id, embedding)
             SELECT cv.mirror_hash || ':' || cv.seq, cv.embedding
             FROM content_vectors cv
             WHERE cv.model = ?
               AND (cv.mirror_hash || ':' || cv.seq) NOT IN (
                 SELECT chunk_id FROM ${tableName}
               )`
          ).run(model);
          const added =
            db.query<{ c: number }, []>("SELECT changes() AS c").get()?.c ?? 0;

          return { added, removed };
        })();

        return Promise.resolve(ok(result));
      } catch (e) {
        return Promise.resolve(
          err(
            "VEC_SYNC_FAILED",
            `Vec sync failed: ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
    },
  };
  return ok(bindVectorIndexDatabase(port, db));
}
