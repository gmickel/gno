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
  hasNullCosineVariant,
  provenOwners,
  vectorProofKey,
} from "./proof-cache";
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

const MAX_VEC0_K = 4096;
const MAX_SQL_BATCH_QUERIES = 8;

interface RankedVariantRow {
  variantId?: number;
  mirrorHash: string;
  seq: number;
  inputHash: string;
  distance: number;
  documentIds: string;
}

interface CandidateRow {
  variantId: number;
  mirrorHash: string;
  seq: number;
  inputHash: string;
  distance: number;
  documentIds: number[];
}

function isNonZeroVector(embedding: Float32Array): boolean {
  let sumSq = 0;
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i]!;
    if (!Number.isFinite(v)) return false;
    sumSq += v * v;
  }
  return sumSq > 0 && Number.isFinite(sumSq);
}

function isMirrorClean(db: Database, partitionId: string): boolean {
  if (
    !db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_mirror_state'"
      )
      .get()
  )
    return false;
  const row = db
    .query<{ dirty: number }, [string]>(
      "SELECT dirty FROM vector_mirror_state WHERE partition_id = ?"
    )
    .get(partitionId);
  return row?.dirty === 0;
}

/** Exact SQLite `ORDER BY distance, mirrorHash, seq, variantId` comparator (NULLS FIRST, binary text). */
function compareVariantCandidates(a: CandidateRow, b: CandidateRow): number {
  const aNull = a.distance === null;
  const bNull = b.distance === null;
  if (aNull !== bNull) return aNull ? -1 : 1;
  if (!aNull && a.distance !== b.distance) return a.distance - b.distance;
  if (a.mirrorHash < b.mirrorHash) return -1;
  if (a.mirrorHash > b.mirrorHash) return 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.variantId - b.variantId;
}

/** Max-heap insertion keeping the smallest `cap` candidates under `compareVariantCandidates`. */
function pushBoundedCandidate(
  heap: CandidateRow[],
  cap: number,
  item: CandidateRow
): void {
  if (heap.length < cap) {
    heap.push(item);
    let idx = heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (compareVariantCandidates(heap[idx]!, heap[parent]!) <= 0) break;
      const tmp = heap[parent]!;
      heap[parent] = heap[idx]!;
      heap[idx] = tmp;
      idx = parent;
    }
    return;
  }
  if (compareVariantCandidates(item, heap[0]!) >= 0) return;
  heap[0] = item;
  let idx = 0;
  const len = heap.length;
  for (;;) {
    const left = idx * 2 + 1;
    const right = left + 1;
    let largest = idx;
    if (left < len && compareVariantCandidates(heap[left]!, heap[largest]!) > 0)
      largest = left;
    if (
      right < len &&
      compareVariantCandidates(heap[right]!, heap[largest]!) > 0
    )
      largest = right;
    if (largest === idx) break;
    const tmp = heap[idx]!;
    heap[idx] = heap[largest]!;
    heap[largest] = tmp;
    idx = largest;
  }
}

function createBatchOwnersStmt(db: Database) {
  return db.query<
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
}

function proveUnknownOwners(
  model: string,
  proofs: Map<string, boolean>,
  candidateLists: readonly (readonly CandidateRow[])[],
  batchOwners: ReturnType<typeof createBatchOwnersStmt>
): void {
  const unknownByTuple = new Map<
    string,
    {
      id: number;
      mirrorHash: string;
      seq: number;
      inputHashes: Set<string>;
    }
  >();
  for (const list of candidateLists) {
    for (const row of list) {
      for (const id of row.documentIds) {
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
  }
  if (unknownByTuple.size === 0) return;
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

function resolveActivePartition(
  db: Database,
  model: string,
  dimensions: number,
  embeddings: readonly Float32Array[],
  options: VectorSearchOptions
): { partitionId: string; tableName: string } | null {
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

  const validDimensions = embeddings.every((e) => e.length === dimensions);
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
      !validDimensions
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
      !validDimensions
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
  return { partitionId, tableName };
}

/**
 * Clean-mirror vec0 fast path for unfiltered searches. Returns exact top-k
 * hits when boundary safety is mathematically proven, or `null` to fall back
 * transparently to the authoritative `vector_variants` scan.
 */
function searchVectorVariantsViaVec0(
  db: Database,
  model: string,
  partitionId: string,
  tableName: string,
  embedding: Float32Array,
  k: number,
  minScore: number | undefined,
  proofs: Map<string, boolean>,
  batchOwners: ReturnType<typeof createBatchOwnersStmt>
): VectorSearchResult[] | null {
  if (k > MAX_VEC0_K || !isNonZeroVector(embedding)) return null;
  const queryVector = encodeEmbedding(embedding);
  const vecK = Math.min(MAX_VEC0_K, Math.max(k + 16, k * 2));
  const vecRows = db
    .query<
      { variantId: number; distance: number | null },
      [Uint8Array, number]
    >(
      `SELECT variant_id AS variantId, distance FROM ${tableName} WHERE embedding MATCH ? AND k = ?`
    )
    .all(queryVector, vecK);
  if (vecRows.length === 0) return [];
  const exhaustedMirror = vecRows.length < vecK;
  const boundaryDistance = vecRows[vecRows.length - 1]!.distance;
  if (
    !exhaustedMirror &&
    (boundaryDistance === null || Number.isNaN(boundaryDistance))
  ) {
    return null;
  }
  const variantIds = vecRows.map((row) => row.variantId);
  const hydrated = db
    .query<RankedVariantRow, [Uint8Array, string, string]>(`
      SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
        v.input_hash AS inputHash,
        vec_distance_cosine(v.embedding, ?) AS distance,
        json_group_array(o.document_id) AS documentIds
      FROM vector_owners o
      JOIN documents d ON d.id = o.document_id AND d.active = 1 AND d.mirror_hash = o.mirror_hash
      JOIN content_chunks c${chunkKeyHint(db)} ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
      JOIN vector_variants v${variantPartitionIdHint(db)}
        ON v.partition_id = o.partition_id AND v.variant_id = o.variant_id
      WHERE o.partition_id = ?
        AND o.variant_id IN (SELECT value FROM json_each(?))
      GROUP BY o.variant_id, o.mirror_hash, o.seq
      ORDER BY distance, o.mirror_hash, o.seq, o.variant_id
    `)
    .all(queryVector, partitionId, JSON.stringify(variantIds));

  let hitMinScoreCutoff = false;
  let cutoffDistance: number | null = null;
  const candidateRows: CandidateRow[] = [];
  for (const row of hydrated) {
    if (minScore !== undefined && 1 - row.distance < minScore) {
      hitMinScoreCutoff = true;
      cutoffDistance = row.distance;
      break;
    }
    candidateRows.push({
      variantId: row.variantId ?? 0,
      mirrorHash: row.mirrorHash,
      seq: row.seq,
      inputHash: row.inputHash,
      distance: row.distance,
      documentIds: JSON.parse(row.documentIds) as number[],
    });
  }
  proveUnknownOwners(model, proofs, [candidateRows], batchOwners);

  const results: VectorSearchResult[] = [];
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

  if (exhaustedMirror) return results;
  if (
    hitMinScoreCutoff &&
    cutoffDistance !== null &&
    cutoffDistance < boundaryDistance!
  ) {
    return results;
  }
  if (
    results.length === k &&
    results[k - 1]!.distance !== null &&
    results[k - 1]!.distance < boundaryDistance!
  ) {
    return results;
  }
  return null;
}

function buildEligibleVariantQuerySpec(
  db: Database,
  partitionId: string,
  options: VectorSearchOptions
) {
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
  const selective = hasSelectiveEligibility(options);
  const innerFrom = selective
    ? `FROM (${eligible.sql}) e
      CROSS JOIN vector_owners o${ownerDocPartHint(db)}
        ON o.document_id = e.id AND o.mirror_hash = e.mirror_hash`
    : `FROM vector_owners o${ownerPartitionVariantHint(db)}
      CROSS JOIN (${eligible.sql}) e
        ON e.id = o.document_id AND e.mirror_hash = o.mirror_hash`;
  return { eligible, conditions, params, innerFrom };
}

function searchVectorVariantsFromVariants(
  db: Database,
  model: string,
  partitionId: string,
  embedding: Float32Array,
  k: number,
  minScore: number | undefined,
  spec: ReturnType<typeof buildEligibleVariantQuerySpec>,
  proofs: Map<string, boolean>,
  batchOwners: ReturnType<typeof createBatchOwnersStmt>
): VectorSearchResult[] {
  const ranked = db.query<RankedVariantRow, (Uint8Array | string | number)[]>(`
    SELECT g.variantId, g.mirrorHash, g.seq, v.input_hash AS inputHash,
      vec_distance_cosine(v.embedding, ?) AS distance, g.documentIds
    FROM (
      SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
        json_group_array(o.document_id) AS documentIds
      ${spec.innerFrom}
      JOIN content_chunks c${chunkKeyHint(db)} ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
      WHERE ${spec.conditions.join(" AND ")}
      GROUP BY o.variant_id, o.mirror_hash, o.seq
    ) g
    CROSS JOIN vector_variants v${variantPartitionIdHint(db)}
      ON v.partition_id = ? AND v.variant_id = g.variantId
    ORDER BY distance, g.mirrorHash, g.seq, g.variantId LIMIT ?
  `);
  const queryVector = encodeEmbedding(embedding);
  let limit = k;
  let results: VectorSearchResult[] = [];
  for (;;) {
    const rows = ranked.all(
      queryVector,
      ...spec.eligible.params,
      ...spec.params,
      partitionId,
      limit
    );
    let hitMinScoreCutoff = false;
    const candidateRows: CandidateRow[] = [];
    for (const row of rows) {
      if (minScore !== undefined && 1 - row.distance < minScore) {
        hitMinScoreCutoff = true;
        break;
      }
      candidateRows.push({
        variantId: row.variantId ?? 0,
        mirrorHash: row.mirrorHash,
        seq: row.seq,
        inputHash: row.inputHash,
        distance: row.distance,
        documentIds: JSON.parse(row.documentIds) as number[],
      });
    }
    proveUnknownOwners(model, proofs, [candidateRows], batchOwners);
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
  const resolved = resolveActivePartition(
    db,
    model,
    dimensions,
    [embedding],
    options
  );
  if (!resolved) return null;
  const { partitionId, tableName } = resolved;
  const spec = buildEligibleVariantQuerySpec(db, partitionId, options);
  const minScore = options.minScore;
  if (minScore !== undefined && Number.isNaN(minScore)) {
    return [];
  }
  const batchOwners = createBatchOwnersStmt(db);
  const proofs = provenOwners(db, inOuterTransaction);

  if (
    !hasSelectiveEligibility(options) &&
    !options.eligibility?.language &&
    isMirrorClean(db, partitionId) &&
    !hasNullCosineVariant(db, partitionId, inOuterTransaction)
  ) {
    const fast = searchVectorVariantsViaVec0(
      db,
      model,
      partitionId,
      tableName,
      embedding,
      k,
      minScore,
      proofs,
      batchOwners
    );
    if (fast !== null) return fast;
  }

  return searchVectorVariantsFromVariants(
    db,
    model,
    partitionId,
    embedding,
    k,
    minScore,
    spec,
    proofs,
    batchOwners
  );
}

/**
 * Batched variant search sharing one snapshot, one eligible scan (when filtered
 * or dirty), and one batched owner proof pass across all query embeddings.
 */
function searchVectorVariantsBatchInSnapshot(
  db: Database,
  model: string,
  dimensions: number,
  embeddings: readonly Float32Array[],
  limits: readonly number[],
  options: VectorSearchOptions,
  inOuterTransaction: boolean
): VectorSearchResult[][] | null {
  const resolved = resolveActivePartition(
    db,
    model,
    dimensions,
    embeddings,
    options
  );
  if (!resolved) return null;
  const { partitionId, tableName } = resolved;
  const spec = buildEligibleVariantQuerySpec(db, partitionId, options);
  const minScore = options.minScore;
  if (minScore !== undefined && Number.isNaN(minScore)) {
    return embeddings.map(() => []);
  }
  const batchOwners = createBatchOwnersStmt(db);
  const proofs = provenOwners(db, inOuterTransaction);

  // Clean unfiltered mirror: use vec0 per query inside this single snapshot.
  const canUseVec0 =
    !hasSelectiveEligibility(options) &&
    !options.eligibility?.language &&
    isMirrorClean(db, partitionId) &&
    !hasNullCosineVariant(db, partitionId, inOuterTransaction);
  if (canUseVec0) {
    return embeddings.map((embedding, i) => {
      const k = limits[i]!;
      const fast = searchVectorVariantsViaVec0(
        db,
        model,
        partitionId,
        tableName,
        embedding,
        k,
        minScore,
        proofs,
        batchOwners
      );
      if (fast !== null) return fast;
      return searchVectorVariantsFromVariants(
        db,
        model,
        partitionId,
        embedding,
        k,
        minScore,
        spec,
        proofs,
        batchOwners
      );
    });
  }

  // Filtered or dirty mirror: scan eligible vector_variants ONCE per chunk of up to 8 queries.
  const allResults: VectorSearchResult[][] = Array.from<VectorSearchResult[]>({
    length: embeddings.length,
  });
  for (
    let offset = 0;
    offset < embeddings.length;
    offset += MAX_SQL_BATCH_QUERIES
  ) {
    const sliceEmbeddings = embeddings.slice(
      offset,
      offset + MAX_SQL_BATCH_QUERIES
    );
    const sliceLimits = limits.slice(offset, offset + MAX_SQL_BATCH_QUERIES);
    const count = sliceEmbeddings.length;
    const distanceSelects = sliceEmbeddings
      .map((_, i) => `vec_distance_cosine(v.embedding, ?) AS d${i}`)
      .join(", ");
    const sql = `
      SELECT g.variantId, g.mirrorHash, g.seq, v.input_hash AS inputHash, g.documentIds,
        ${distanceSelects}
      FROM (
        SELECT o.variant_id AS variantId, o.mirror_hash AS mirrorHash, o.seq,
          json_group_array(o.document_id) AS documentIds
        ${spec.innerFrom}
        JOIN content_chunks c${chunkKeyHint(db)} ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
        WHERE ${spec.conditions.join(" AND ")}
        GROUP BY o.variant_id, o.mirror_hash, o.seq
      ) g
      CROSS JOIN vector_variants v${variantPartitionIdHint(db)}
        ON v.partition_id = ? AND v.variant_id = g.variantId
    `;
    const queryVectors = sliceEmbeddings.map((e) => encodeEmbedding(e));
    const heaps: CandidateRow[][] = sliceLimits.map(() => []);
    const caps = sliceLimits.map((k) => Math.max(k + 32, k * 2));
    let totalEligibleRows = 0;
    const stmt = db.prepare<
      Record<string, unknown>,
      (Uint8Array | string | number)[]
    >(sql);
    try {
      for (const row of stmt.iterate(
        ...queryVectors,
        ...spec.eligible.params,
        ...spec.params,
        partitionId
      )) {
        totalEligibleRows++;
        const variantId = row.variantId as number;
        const mirrorHash = row.mirrorHash as string;
        const seq = row.seq as number;
        const inputHash = row.inputHash as string;
        let parsedDocIds: number[] | null = null;
        for (let q = 0; q < count; q++) {
          const distance = row[`d${q}`] as number;
          const heap = heaps[q]!;
          const cap = caps[q]!;
          // Quick reject before JSON.parse when heap is already full with a better worst element
          if (heap.length >= cap) {
            const worst = heap[0]!;
            const aNull = distance === null;
            const bNull = worst.distance === null;
            if (!aNull && bNull) continue;
            if (!aNull && !bNull && distance > worst.distance) continue;
          }
          parsedDocIds ??= JSON.parse(row.documentIds as string) as number[];
          pushBoundedCandidate(heap, cap, {
            variantId,
            mirrorHash,
            seq,
            inputHash,
            distance,
            documentIds: parsedDocIds,
          });
        }
      }
    } finally {
      stmt.finalize();
    }

    const sortedCandidates: CandidateRow[][] = [];
    const hitCutoffs: boolean[] = [];
    for (let q = 0; q < count; q++) {
      const heap = heaps[q]!;
      heap.sort(compareVariantCandidates);
      let hitCutoff = false;
      const kept: CandidateRow[] = [];
      for (const row of heap) {
        if (minScore !== undefined && 1 - row.distance < minScore) {
          hitCutoff = true;
          break;
        }
        kept.push(row);
      }
      sortedCandidates.push(kept);
      hitCutoffs.push(hitCutoff);
    }

    proveUnknownOwners(model, proofs, sortedCandidates, batchOwners);

    for (let q = 0; q < count; q++) {
      const k = sliceLimits[q]!;
      const results: VectorSearchResult[] = [];
      for (const row of sortedCandidates[q]!) {
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
      if (
        results.length < k &&
        !hitCutoffs[q] &&
        totalEligibleRows > caps[q]!
      ) {
        allResults[offset + q] = searchVectorVariantsFromVariants(
          db,
          model,
          partitionId,
          sliceEmbeddings[q]!,
          k,
          minScore,
          spec,
          proofs,
          batchOwners
        );
      } else {
        allResults[offset + q] = results;
      }
    }
  }
  return allResults;
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

/** Keep batched eligibility, provenance validation and ranking on one SQLite snapshot. */
export function searchVectorVariantsBatch(
  db: Database,
  model: string,
  dimensions: number,
  embeddings: readonly Float32Array[],
  limits: readonly number[],
  options: VectorSearchOptions = {}
): VectorSearchResult[][] | null {
  const inOuterTransaction = db.inTransaction;
  return db.transaction(() =>
    searchVectorVariantsBatchInSnapshot(
      db,
      model,
      dimensions,
      embeddings,
      limits,
      options,
      inOuterTransaction
    )
  )();
}
