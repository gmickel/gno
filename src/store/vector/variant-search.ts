import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../../llm/types";
import type {
  VectorIndexPort,
  VectorSearchOptions,
  VectorSearchResult,
  VectorVariantIdentity,
} from "./types";

import { formatDocForEmbedding } from "../../pipeline/contextual";
import { buildEligibleDocumentQuery } from "../sqlite/eligibility";
import {
  embeddingPartitionIdentity,
  identityPartitionId,
  resolveRuntimePartition,
  retrievalUse,
} from "./runtime-compat";
import { encodeEmbedding, getVectorIndexDatabase } from "./sqlite-vec";
import { embeddingInputHash } from "./variants";

/** Fallback/warning code: this runtime may not read the activated vectors. */
export const VECTOR_RUNTIME_INCOMPATIBLE = "vector_runtime_incompatible";

export type SearchPartition =
  | { identity?: VectorVariantIdentity; unavailable?: undefined }
  | {
      identity?: undefined;
      /** Why this runtime cannot read vectors; callers phrase the fallback. */
      unavailable: { reason: string; building: boolean };
    };

/**
 * Call after query embedding initialized the port. A runtime that cannot use
 * an activated partition gets a reason instead of an identity; vector spaces
 * are never mixed.
 */
export async function resolveVectorSearchIdentity(
  port: EmbeddingPort,
  vectorIndex: VectorIndexPort
): Promise<SearchPartition> {
  const primary = embeddingPartitionIdentity(port);
  const db = getVectorIndexDatabase(vectorIndex);
  if (!primary || !db) return { identity: primary };
  let resolved;
  try {
    resolved = await resolveRuntimePartition(db, port, primary);
  } catch (cause) {
    return {
      unavailable: {
        reason: `the runtime compatibility check failed (${cause instanceof Error ? cause.message : String(cause)})`,
        building: false,
      },
    };
  }
  const use = retrievalUse(
    db,
    resolved.blocked
      ? { kind: "blocked", ...resolved.blocked }
      : { kind: "use", identity: resolved.identity, verdict: resolved.verdict }
  );
  if (use.kind === "unavailable")
    return { unavailable: { reason: use.reason, building: use.building } };
  return { identity: resolved.identity };
}

/** Result notice for hybrid retrieval, which falls back to lexical. */
export function lexicalFallbackNotice(
  unavailable: NonNullable<SearchPartition["unavailable"]>
): string {
  return `Semantic search unavailable for this runtime: ${unavailable.reason}. Using lexical retrieval only; ${unavailable.building ? "finish it with `gno embed`" : "see `gno status`"}.`;
}

/** vsearch cannot fall back; it says what the caller can do instead. */
export function vectorSearchUnavailableMessage(
  unavailable: NonNullable<SearchPartition["unavailable"]>
): string {
  return `Vector search unavailable for this runtime: ${unavailable.reason}. ${
    unavailable.building
      ? "Finish the partition with `gno embed`, or use `gno query` / `gno search`."
      : "Use `gno query` or `gno search`, or build a separate partition with `gno embed --new-partition`."
  }`;
}

const MAX_CACHED_PROOFS = 100_000;
const proofCaches = new WeakMap<
  Database,
  { marker: string; proofs: Map<string, boolean> }
>();

/**
 * Input-hash proofs cached per connection. Any committed write, from this
 * connection or another, changes the marker and drops the cache, so a cached
 * proof never outlives the titles and chunk text it was computed from.
 */
function provenOwners(db: Database): Map<string, boolean> {
  const { version, changes } = db
    .query<{ version: number; changes: number }, []>(
      "SELECT (SELECT data_version FROM pragma_data_version) AS version, total_changes() AS changes"
    )
    .get()!;
  const marker = `${version}:${changes}`;
  let cache = proofCaches.get(db);
  if (cache?.marker !== marker || cache.proofs.size > MAX_CACHED_PROOFS) {
    cache = { marker, proofs: new Map() };
    proofCaches.set(db, cache);
  }
  return cache.proofs;
}

/** Null means legacy authority. Once promoted, unavailable provenance fails closed. */
function searchVectorVariantsInSnapshot(
  db: Database,
  model: string,
  dimensions: number,
  embedding: Float32Array,
  k: number,
  options: VectorSearchOptions = {}
): VectorSearchResult[] | null {
  if (
    !db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'vector_partitions'")
      .get()
  )
    return null;
  const activated = db
    .query(
      "SELECT 1 FROM vector_partitions WHERE model = ? AND state = 'active' AND activated_epoch IS NOT NULL LIMIT 1"
    )
    .get(model);
  const identity = options.embeddingIdentity;
  let partitionId: string;
  if (options.partitionId !== undefined) {
    const stored = db
      .query<{ model: string; dimensions: number }, [string]>(
        "SELECT model, dimensions FROM vector_partitions WHERE partition_id = ?"
      )
      .get(options.partitionId);
    if (
      stored?.model !== model ||
      stored.dimensions !== dimensions ||
      embedding.length !== dimensions
    )
      throw new Error("Stored vector partition does not match vector index");
    partitionId = options.partitionId;
  } else {
    if (!identity) {
      if (activated)
        throw new Error(
          "Effective embedding identity unavailable after variant activation"
        );
      return null;
    }
    if (
      identity.model !== model ||
      identity.dimensions !== dimensions ||
      embedding.length !== dimensions
    )
      throw new Error("Query embedding identity does not match vector index");
    partitionId = identityPartitionId(identity);
  }
  const partition = db
    .query<{ state: string; activated_epoch: number | null }, [string]>(
      "SELECT state, activated_epoch FROM vector_partitions WHERE partition_id = ?"
    )
    .get(partitionId);
  if (partition?.state !== "active" || partition.activated_epoch === null) {
    if (activated || options.partitionId !== undefined)
      throw new Error(
        "Selected embedding variant partition has not activated; run gno embed"
      );
    return null;
  }
  const tableName = `vec_v1_${partitionId}`;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(tableName))
    throw new Error("Activated variant index unavailable; run gno embed");
  // The vec0 mirror is written in the same transactions as vector_variants and
  // checked at activation and by `gno vec sync`; ranking below reads only
  // vector_variants, so the mirror is never trusted here.
  const eligible = buildEligibleDocumentQuery(
    { ...options.eligibility, semanticMetadata: true },
    db
  );
  const conditions = ["o.partition_id = ?"];
  const params: (string | number)[] = [partitionId];
  if (options.eligibility?.language) {
    conditions.push("c.language = ?");
    params.push(options.eligibility.language);
  }
  if (options.allowedMirrorHashes !== undefined) {
    conditions.push("o.mirror_hash IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedMirrorHashes));
  }
  // Owner eligibility precedes ranking/LIMIT. Grouping before the distance
  // keeps embedding blobs out of the group sorter.
  const ranked = db.query<
    {
      mirrorHash: string;
      seq: number;
      inputHash: string;
      distance: number;
      documentIds: string;
    },
    (Uint8Array | string | number)[]
  >(`
    SELECT g.mirrorHash, g.seq, v.input_hash AS inputHash,
      vec_distance_cosine(v.embedding, ?) AS distance, g.documentIds
    FROM (
      SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
        json_group_array(o.document_id) AS documentIds
      FROM vector_owners o
      JOIN (${eligible.sql}) e ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
      JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
      WHERE ${conditions.join(" AND ")}
      GROUP BY o.variant_id, o.mirror_hash, o.seq
    ) g
    JOIN vector_variants v ON v.variant_id = g.variantId AND v.partition_id = ?
    ORDER BY distance, g.mirrorHash, g.seq, g.variantId LIMIT ?
  `);
  const owners = db.query<
    { id: number; title: string | null; text: string },
    [string, number, string]
  >(`
    SELECT d.id, d.title, c.text FROM documents d
    JOIN content_chunks c ON c.mirror_hash = ? AND c.seq = ?
    WHERE d.id IN (SELECT value FROM json_each(?))
  `);
  // A vector counts only while it matches its owner's current formatted
  // input. Proving candidates in rank order and skipping unproven owners
  // returns exactly what filtering every owner before ranking would.
  const proofs = provenOwners(db);
  const queryVector = encodeEmbedding(embedding);
  let limit = k;
  let results: VectorSearchResult[] = [];
  for (;;) {
    const rows = ranked.all(
      queryVector,
      ...eligible.params,
      ...params,
      partitionId,
      limit
    );
    results = [];
    for (const row of rows) {
      const documentIds = JSON.parse(row.documentIds) as number[];
      const key = (id: number) =>
        `${model}\0${id}\0${row.mirrorHash}\0${row.seq}\0${row.inputHash}`;
      const unknown = documentIds.filter((id) => !proofs.has(key(id)));
      if (unknown.length > 0) {
        for (const owner of owners.all(
          row.mirrorHash,
          row.seq,
          JSON.stringify(unknown)
        )) {
          proofs.set(
            key(owner.id),
            embeddingInputHash(
              formatDocForEmbedding(owner.text, owner.title ?? undefined, model)
            ) === row.inputHash
          );
        }
      }
      const proven = documentIds.filter((id) => proofs.get(key(id)));
      if (proven.length === 0) continue;
      results.push({
        mirrorHash: row.mirrorHash,
        seq: row.seq,
        distance: row.distance,
        documentIds: proven,
      });
      if (results.length === k) break;
    }
    if (results.length === k || rows.length < limit) break;
    limit *= 4;
  }
  return results.filter(
    (row) =>
      options.minScore === undefined || 1 - row.distance >= options.minScore
  );
}

/** Keep eligibility, provenance validation and ranking on one SQLite snapshot. */
export function searchVectorVariants(
  db: Database,
  model: string,
  dimensions: number,
  embedding: Float32Array,
  k: number,
  options: VectorSearchOptions = {}
): VectorSearchResult[] | null {
  return db.transaction(() =>
    searchVectorVariantsInSnapshot(db, model, dimensions, embedding, k, options)
  )();
}
