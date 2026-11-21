/**
 * Per-connection input-hash proof cache keyed on `vector_variant_epoch.epoch`.
 *
 * Every mutation to `documents`, `content_chunks`, `vector_owners`, or
 * `vector_variants` increments `vector_variant_epoch.epoch` via migration 028
 * triggers, so proofs survive unrelated writes (`retrieval_traces`,
 * `llm_cache`, `egress_audit_receipts`, `vector_runtime_callers`) while still
 * invalidating across connections whenever document titles or chunk text change.
 *
 * When a caller is already inside an uncommitted outer transaction
 * (`inOuterTransaction === true`), a call-local Map is returned so a later
 * `ROLLBACK` can never poison the connection-shared cache.
 *
 * @module src/store/vector/proof-cache
 */
import type { Database } from "bun:sqlite";

const MAX_CACHED_PROOFS = 100_000;

const proofCaches = new WeakMap<
  Database,
  {
    epoch: number;
    proofs: Map<string, boolean>;
    nullCosinePartitions: Map<string, boolean>;
  }
>();

export function vectorProofKey(
  model: string,
  documentId: number,
  mirrorHash: string,
  seq: number,
  inputHash: string
): string {
  return `${model}\0${documentId}\0${mirrorHash}\0${seq}\0${inputHash}`;
}

function getEpochCache(
  db: Database,
  inOuterTransaction: boolean
): {
  proofs: Map<string, boolean>;
  nullCosinePartitions: Map<string, boolean>;
} | null {
  if (inOuterTransaction) {
    return null;
  }
  const row = db
    .query<{ epoch: number }, []>(
      "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
    )
    .get();
  if (!row) {
    return null;
  }
  let cache = proofCaches.get(db);
  if (cache?.epoch !== row.epoch || cache.proofs.size > MAX_CACHED_PROOFS) {
    cache = {
      epoch: row.epoch,
      proofs: new Map(),
      nullCosinePartitions: new Map(),
    };
    proofCaches.set(db, cache);
  }
  return cache;
}

export function provenOwners(
  db: Database,
  inOuterTransaction: boolean
): Map<string, boolean> {
  return getEpochCache(db, inOuterTransaction)?.proofs ?? new Map();
}

/**
 * True if the partition contains any variant whose cosine distance can be NULL
 * (e.g. an all-zero vector). Cached per (db, partitionId, epoch) so the vec0
 * fast path stays O(1) while preserving exact SQLite NULLS FIRST parity.
 */
export function hasNullCosineVariant(
  db: Database,
  partitionId: string,
  inOuterTransaction: boolean
): boolean {
  const cache = getEpochCache(db, inOuterTransaction);
  const cached = cache?.nullCosinePartitions.get(partitionId);
  if (cached !== undefined) {
    return cached;
  }
  const found = Boolean(
    db
      .query<unknown, [string]>(
        `SELECT 1 FROM vector_variants
         WHERE partition_id = ?
           AND vec_distance_cosine(embedding, embedding) IS NULL
         LIMIT 1`
      )
      .get(partitionId)
  );
  cache?.nullCosinePartitions.set(partitionId, found);
  return found;
}
