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
  isPartitionActivated,
  resolveRuntimePartition,
} from "./runtime-compat";
import { encodeEmbedding, getVectorIndexDatabase } from "./sqlite-vec";
import { embeddingInputHash } from "./variants";

/** Fallback/warning code: this runtime may not read the activated vectors. */
export const VECTOR_RUNTIME_INCOMPATIBLE = "vector_runtime_incompatible";

export type SearchPartition =
  | { identity?: VectorVariantIdentity; notice?: undefined }
  | { identity?: undefined; notice: string };

/**
 * Call after query embedding initialized the port. A runtime that cannot use
 * an activated partition gets a notice and must fall back to lexical retrieval;
 * vector spaces are never mixed.
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
      notice: `Semantic search unavailable: the runtime compatibility check failed (${cause instanceof Error ? cause.message : String(cause)}). Using lexical retrieval only.`,
    };
  }
  if (resolved.blocked)
    return {
      notice: `Semantic search unavailable for this runtime: ${resolved.blocked.reason}. Using lexical retrieval only; see \`gno status\`.`,
    };
  const activatedElsewhere = db
    .query(
      "SELECT 1 FROM vector_partitions WHERE model = ? AND state = 'active' AND activated_epoch IS NOT NULL LIMIT 1"
    )
    .get(primary.model);
  if (
    activatedElsewhere &&
    !isPartitionActivated(db, identityPartitionId(resolved.identity))
  )
    return {
      notice:
        "Semantic search unavailable for this runtime: its vector partition is still being built. Using lexical retrieval only; run `gno embed`.",
    };
  return { identity: resolved.identity };
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
  const partitionId = identityPartitionId(identity);
  const partition = db
    .query<{ state: string; activated_epoch: number | null }, [string]>(
      "SELECT state, activated_epoch FROM vector_partitions WHERE partition_id = ?"
    )
    .get(partitionId);
  if (partition?.state !== "active" || partition.activated_epoch === null) {
    if (activated)
      throw new Error(
        "Selected embedding variant partition has not activated; run gno embed"
      );
    return null;
  }
  const tableName = `vec_v1_${partitionId}`;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(tableName))
    throw new Error("Activated variant index unavailable; run gno embed");
  if (
    db
      .query(
        `SELECT 1 FROM vector_variants v LEFT JOIN ${tableName} x ON x.variant_id = v.variant_id WHERE v.partition_id = ? AND (x.variant_id IS NULL OR x.embedding != v.embedding) LIMIT 1`
      )
      .get(partitionId)
  )
    throw new Error("Activated variant index inconsistent; run gno embed");
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
  const bindings = db
    .query<
      {
        document_id: number;
        seq: number;
        text: string;
        title: string | null;
        input_hash: string;
      },
      (string | number)[]
    >(`
    SELECT o.document_id, o.seq, c.text, d.title, v.input_hash
    FROM vector_owners o
    JOIN (${eligible.sql}) e ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
    JOIN documents d ON d.id = o.document_id
    JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
    WHERE ${conditions.join(" AND ")}
  `)
    .all(...eligible.params, ...params);
  const proven = bindings
    .filter(
      (row) =>
        row.input_hash ===
        embeddingInputHash(
          formatDocForEmbedding(row.text, row.title ?? undefined, model)
        )
    )
    .map((row) => `${row.document_id}:${row.seq}`);
  // Both owner eligibility and formatted-input validation precede ranking/LIMIT.
  const rows = db
    .query<
      {
        mirrorHash: string;
        seq: number;
        distance: number;
        documentIds: string;
      },
      (Uint8Array | string | number)[]
    >(`
    SELECT o.mirror_hash AS mirrorHash, o.seq, vec_distance_cosine(v.embedding, ?) AS distance,
      json_group_array(o.document_id) AS documentIds
    FROM vector_owners o
    JOIN (${eligible.sql}) e ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash
    JOIN documents d ON d.id = o.document_id
    JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
    JOIN ${tableName} x ON x.variant_id = v.variant_id AND x.embedding = v.embedding
    WHERE ${conditions.join(" AND ")}
      AND (o.document_id || ':' || o.seq) IN (SELECT value FROM json_each(?))
    GROUP BY v.variant_id, o.mirror_hash, o.seq
    ORDER BY distance, o.mirror_hash, o.seq, v.variant_id LIMIT ?
  `)
    .all(
      encodeEmbedding(embedding),
      ...eligible.params,
      ...params,
      JSON.stringify(proven),
      k
    );
  return rows
    .filter(
      (row) =>
        options.minScore === undefined || 1 - row.distance >= options.minScore
    )
    .map((row) => ({
      ...row,
      documentIds: JSON.parse(row.documentIds) as number[],
    }));
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
