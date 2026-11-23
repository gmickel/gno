/**
 * Per-connection input-hash proof cache keyed on `vector_variant_epoch.epoch`,
 * plus O(1) persisted null-cosine state lookup backed by `vector_mirror_state`.
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

import {
  hasNullCosineColumn,
  probePartitionNullCosine,
} from "./partition-index";

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

function readVariantEpoch(db: Database): number | null {
  const row = db
    .query<{ epoch: number }, []>(
      "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
    )
    .get();
  return row ? row.epoch : null;
}

function getEpochCache(
  db: Database,
  inOuterTransaction: boolean
): {
  epoch: number;
  proofs: Map<string, boolean>;
  nullCosinePartitions: Map<string, boolean>;
} | null {
  if (inOuterTransaction) {
    return null;
  }
  const epoch = readVariantEpoch(db);
  if (epoch === null) {
    return null;
  }
  let cache = proofCaches.get(db);
  if (cache?.epoch !== epoch || cache.proofs.size > MAX_CACHED_PROOFS) {
    cache = {
      epoch,
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

export interface NullCosineCheckResult {
  found: boolean;
  /**
   * Non-null when this call had to scan `vector_variants` because
   * `vector_mirror_state.null_cosine` was NULL, carrying the variant epoch
   * observed inside the read snapshot for a guarded post-snapshot persist.
   */
  persistAfterSnapshot?: {
    partitionId: string;
    value: 0 | 1;
    epoch: number;
  };
}

/**
 * Inspect whether `partitionId` contains any null-cosine variant.
 *
 * Checks persisted `vector_mirror_state.null_cosine` first (O(1) PK lookup,
 * surviving cold CLI starts and unrelated document/chunk edits), then the
 * connection-local epoch cache, and only falls back to the `LIMIT 1` probe
 * when unknown (`NULL`). Never writes inside the read snapshot.
 */
export function checkNullCosineVariant(
  db: Database,
  partitionId: string,
  inOuterTransaction: boolean
): NullCosineCheckResult {
  let mirrorCleanWithUnknown = false;
  if (hasNullCosineColumn(db)) {
    const persisted = db
      .query<{ dirty: number; null_cosine: number | null }, [string]>(
        "SELECT dirty, null_cosine FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(partitionId);
    if (persisted?.dirty === 0) {
      if (persisted.null_cosine === 0 || persisted.null_cosine === 1) {
        return { found: persisted.null_cosine === 1 };
      }
      mirrorCleanWithUnknown = true;
    }
  }

  const cache = getEpochCache(db, inOuterTransaction);
  const cached = cache?.nullCosinePartitions.get(partitionId);
  if (cached !== undefined) {
    return {
      found: cached,
      ...(mirrorCleanWithUnknown && cache
        ? {
            persistAfterSnapshot: {
              partitionId,
              value: cached ? 1 : 0,
              epoch: cache.epoch,
            },
          }
        : {}),
    };
  }

  const found = probePartitionNullCosine(db, partitionId);
  cache?.nullCosinePartitions.set(partitionId, found);
  const epoch = cache?.epoch ?? readVariantEpoch(db);
  return {
    found,
    ...(mirrorCleanWithUnknown && !inOuterTransaction && epoch !== null
      ? {
          persistAfterSnapshot: {
            partitionId,
            value: found ? 1 : 0,
            epoch,
          },
        }
      : {}),
  };
}

/**
 * True if the partition contains any variant whose cosine distance can be NULL
 * (e.g. an all-zero vector or float32 norm underflow/overflow).
 */
export function hasNullCosineVariant(
  db: Database,
  partitionId: string,
  inOuterTransaction: boolean
): boolean {
  return checkNullCosineVariant(db, partitionId, inOuterTransaction).found;
}

/**
 * Best-effort guarded persist of a probed `null_cosine` flag after the search's
 * read snapshot closes. Skips on query-only connections, active transactions,
 * changed variant epoch, dirty mirrors, or lock contention.
 */
export function persistNullCosineAfterSnapshot(
  writerDb: Database,
  pending: NonNullable<NullCosineCheckResult["persistAfterSnapshot"]>
): boolean {
  if (writerDb.inTransaction) return false;
  try {
    const queryOnly =
      writerDb.query<{ query_only: number }, []>("PRAGMA query_only").get()
        ?.query_only === 1;
    if (queryOnly) return false;
    if (!hasNullCosineColumn(writerDb)) return false;
    writerDb.run(
      `UPDATE vector_mirror_state
       SET null_cosine = ?
       WHERE partition_id = ?
         AND dirty = 0
         AND null_cosine IS NULL
         AND (SELECT epoch FROM vector_variant_epoch WHERE id = 1) = ?`,
      [pending.value, pending.partitionId, pending.epoch]
    );
    return (
      (writerDb.query<{ c: number }, []>("SELECT changes() AS c").get()?.c ??
        0) > 0
    );
  } catch {
    // Busy/locked writer or read-only file: skip silently, probe cache stays valid.
    return false;
  }
}
