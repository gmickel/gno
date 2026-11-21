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
import { provenOwners, vectorProofKey } from "./proof-cache";
import {
  embeddingPartitionIdentity,
  identityPartitionId,
  isPartitionActivated,
  resolveRuntimePartition,
  retrievalUse,
} from "./runtime-compat";
import {
  encodeEmbedding,
  getVectorIndexDatabase,
  writerConnection,
  writerIdle,
} from "./sqlite-vec";
import {
  chunkKeyHint,
  embeddingInputHash,
  ownerDocPartHint,
  ownerPartitionVariantHint,
  variantPartitionIdHint,
} from "./variants";

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
export function resolveVectorSearchIdentity(
  port: EmbeddingPort,
  vectorIndex: VectorIndexPort
): Promise<SearchPartition> {
  return resolveSearchPartition(port, vectorIndex, false);
}

async function resolveSearchPartition(
  port: EmbeddingPort,
  vectorIndex: VectorIndexPort,
  waited: boolean
): Promise<SearchPartition> {
  const primary = embeddingPartitionIdentity(port);
  const indexDb = getVectorIndexDatabase(vectorIndex);
  if (!primary || !indexDb) return { identity: primary };
  const db = writerConnection(indexDb);
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
  // A first query on an upgraded index can migrate its legacy partition inside
  // a sync batch still open on the shared connection; the read connection sees
  // it only once that batch commits. Wait for that one batch, then resolve
  // again (the migration commits with it, or reruns if the batch rolled back).
  const partitionId = identityPartitionId(resolved.identity);
  if (
    indexDb !== db &&
    isPartitionActivated(db, partitionId) &&
    !isPartitionActivated(indexDb, partitionId)
  ) {
    if (!waited) {
      await writerIdle(indexDb);
      return resolveSearchPartition(port, vectorIndex, true);
    }
    return {
      unavailable: {
        reason:
          "its vector partition is being migrated while the index syncs; retry shortly",
        building: false,
      },
    };
  }
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

function hasSelectiveEligibility(options: VectorSearchOptions): boolean {
  if (options.allowedMirrorHashes !== undefined) return true;
  const e = options.eligibility;
  if (!e) return false;
  return Boolean(
    e.collection ||
    e.collections !== undefined ||
    e.filter ||
    e.tagsAny?.length ||
    e.tagsAll?.length ||
    e.since ||
    e.until ||
    e.categories?.length ||
    e.author ||
    e.relPathPrefix !== undefined ||
    e.memoryScopesAny?.length ||
    e.excludeSuperseded ||
    e.exclude?.length ||
    e.chunkLanguage ||
    e.allowedMirrorHashes !== undefined
  );
}

/** Null means legacy authority. Once promoted, unavailable provenance fails closed. */
function searchVectorVariantsInSnapshot(
  db: Database,
  model: string,
  dimensions: number,
  embedding: Float32Array,
  k: number,
  options: VectorSearchOptions,
  inOuterTransaction: boolean
): VectorSearchResult[] | null {
  if (
    !db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'vector_partitions'")
      .get()
  )
    return null;

  const hasActivatedForModel = (): boolean =>
    Boolean(
      db
        .query(
          "SELECT 1 FROM vector_partitions WHERE model = ? AND state = 'active' AND activated_epoch IS NOT NULL LIMIT 1"
        )
        .get(model)
    );

  const identity = options.embeddingIdentity;
  let partitionId: string;
  if (options.partitionId !== undefined) {
    const stored = db
      .query<
        {
          model: string;
          dimensions: number;
          state: string;
          activated_epoch: number | null;
        },
        [string]
      >(
        "SELECT model, dimensions, state, activated_epoch FROM vector_partitions WHERE partition_id = ?"
      )
      .get(options.partitionId);
    if (
      stored?.model !== model ||
      stored.dimensions !== dimensions ||
      embedding.length !== dimensions
    )
      throw new Error("Stored vector partition does not match vector index");
    if (stored.state !== "active" || stored.activated_epoch === null)
      throw new Error(
        "Selected embedding variant partition has not activated; run gno embed"
      );
    partitionId = options.partitionId;
  } else {
    if (!identity) {
      if (hasActivatedForModel())
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
    const partition = db
      .query<{ state: string; activated_epoch: number | null }, [string]>(
        "SELECT state, activated_epoch FROM vector_partitions WHERE partition_id = ?"
      )
      .get(partitionId);
    if (partition?.state !== "active" || partition.activated_epoch === null) {
      if (hasActivatedForModel())
        throw new Error(
          "Selected embedding variant partition has not activated; run gno embed"
        );
      return null;
    }
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
  const minScore = options.minScore;
  if (minScore !== undefined && Number.isNaN(minScore)) {
    return [];
  }
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
  const selective = hasSelectiveEligibility(options);
  const innerFrom = selective
    ? `FROM (${eligible.sql}) e
      CROSS JOIN vector_owners o${ownerDocPartHint(db)}
        ON o.document_id = e.id AND o.mirror_hash = e.mirror_hash`
    : `FROM vector_owners o${ownerPartitionVariantHint(db)}
      CROSS JOIN (${eligible.sql}) e
        ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash`;
  // Owner eligibility precedes ranking/LIMIT. Grouping before the distance
  // keeps embedding blobs out of the group sorter; CROSS JOIN pins the join
  // order even with stale or absent sqlite_stat1 statistics.
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
      ${innerFrom}
      JOIN content_chunks c${chunkKeyHint(db)} ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
      WHERE ${conditions.join(" AND ")}
      GROUP BY o.variant_id, o.mirror_hash, o.seq
    ) g
    CROSS JOIN vector_variants v${variantPartitionIdHint(db)}
      ON v.partition_id = ? AND v.variant_id = g.variantId
    ORDER BY distance, g.mirrorHash, g.seq, g.variantId LIMIT ?
  `);
  const batchOwners = db.query<
    {
      id: number;
      mirrorHash: string;
      seq: number;
      title: string | null;
      text: string;
    },
    [string]
  >(`
    WITH req AS (
      SELECT
        json_extract(value, '$[0]') AS document_id,
        json_extract(value, '$[1]') AS mirror_hash,
        json_extract(value, '$[2]') AS seq
      FROM json_each(?)
    )
    SELECT r.document_id AS id, r.mirror_hash AS mirrorHash, r.seq, d.title, c.text
    FROM req r
    JOIN documents d ON d.id = r.document_id
    JOIN content_chunks c ON c.mirror_hash = r.mirror_hash AND c.seq = r.seq
  `);
  // A vector counts only while it matches its owner's current formatted
  // input. Proving candidates in rank order and skipping unproven owners
  // returns exactly what filtering every owner before ranking would.
  const proofs = provenOwners(db, inOuterTransaction);
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
    let hitMinScoreCutoff = false;
    const candidateRows: Array<{
      mirrorHash: string;
      seq: number;
      inputHash: string;
      distance: number;
      documentIds: number[];
    }> = [];
    const unknownByTuple = new Map<
      string,
      {
        id: number;
        mirrorHash: string;
        seq: number;
        inputHashes: Set<string>;
      }
    >();
    for (const row of rows) {
      if (minScore !== undefined && 1 - row.distance < minScore) {
        hitMinScoreCutoff = true;
        break;
      }
      const documentIds = JSON.parse(row.documentIds) as number[];
      candidateRows.push({
        mirrorHash: row.mirrorHash,
        seq: row.seq,
        inputHash: row.inputHash,
        distance: row.distance,
        documentIds,
      });
      for (const id of documentIds) {
        const key = vectorProofKey(
          model,
          id,
          row.mirrorHash,
          row.seq,
          row.inputHash
        );
        if (!proofs.has(key)) {
          const tupleKey = `${id}\0${row.mirrorHash}\0${row.seq}`;
          let entry = unknownByTuple.get(tupleKey);
          if (!entry) {
            entry = {
              id,
              mirrorHash: row.mirrorHash,
              seq: row.seq,
              inputHashes: new Set(),
            };
            unknownByTuple.set(tupleKey, entry);
          }
          entry.inputHashes.add(row.inputHash);
        }
      }
    }
    if (unknownByTuple.size > 0) {
      const payload = JSON.stringify(
        Array.from(unknownByTuple.values(), (entry) => [
          entry.id,
          entry.mirrorHash,
          entry.seq,
        ])
      );
      const seenTuples = new Set<string>();
      for (const owner of batchOwners.all(payload)) {
        const tupleKey = `${owner.id}\0${owner.mirrorHash}\0${owner.seq}`;
        seenTuples.add(tupleKey);
        const entry = unknownByTuple.get(tupleKey);
        if (!entry) continue;
        const actualHash = embeddingInputHash(
          formatDocForEmbedding(owner.text, owner.title ?? undefined, model)
        );
        for (const expectedHash of entry.inputHashes) {
          proofs.set(
            vectorProofKey(
              model,
              owner.id,
              owner.mirrorHash,
              owner.seq,
              expectedHash
            ),
            actualHash === expectedHash
          );
        }
      }
      for (const [tupleKey, entry] of unknownByTuple) {
        if (seenTuples.has(tupleKey)) continue;
        for (const expectedHash of entry.inputHashes) {
          proofs.set(
            vectorProofKey(
              model,
              entry.id,
              entry.mirrorHash,
              entry.seq,
              expectedHash
            ),
            false
          );
        }
      }
    }
    results = [];
    for (const row of candidateRows) {
      const proven = row.documentIds
        .filter((id) =>
          proofs.get(
            vectorProofKey(model, id, row.mirrorHash, row.seq, row.inputHash)
          )
        )
        .sort((a, b) => a - b);
      if (proven.length === 0) continue;
      results.push({
        mirrorHash: row.mirrorHash,
        seq: row.seq,
        distance: row.distance,
        documentIds: proven,
      });
      if (results.length === k) break;
    }
    if (results.length === k || hitMinScoreCutoff || rows.length < limit) break;
    limit *= 4;
  }
  return results;
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
  const inOuterTransaction = db.inTransaction;
  return db.transaction(() =>
    searchVectorVariantsInSnapshot(
      db,
      model,
      dimensions,
      embedding,
      k,
      options,
      inOuterTransaction
    )
  )();
}
