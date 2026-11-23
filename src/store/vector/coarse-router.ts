/**
 * Cost-based vector search router and centralized constants (fn-235).
 *
 * Every path returns exact float32 cosine distances. Small scopes and every
 * filtered search stay on existing exact paths; large unfiltered or
 * collection-scoped searches route to the two-stage bit coarse mirror when
 * enabled, clean, and self-checked above the recall floor.
 *
 * @module src/store/vector/coarse-router
 */
import type { Database } from "bun:sqlite";

import type { VectorSearchOptions } from "./types";

/**
 * Single source of truth for fn-235 router and self-check constants.
 * Enabled by default per owner decision (2026-11-23), gated by the per-index
 * build-time recall self-check (floor 0.95) and controllable via
 * `coarseVectorSearch: false`.
 */
export const COARSE_ROUTER_DEFAULTS = {
  /** Default config switch (ON; set `coarseVectorSearch: false` to disable). */
  enabledByDefault: true,
  /** Exact-cost budget in microseconds (100 ms). */
  exactBudgetUs: 100_000,
  /** Exact SQL scan per-vector fixed overhead (µs). */
  exactFixedUsPerVec: 1.05,
  /** Exact SQL scan per-vector per-query cosine cost (µs). */
  exactQueryUsPerVec: 0.82,
  /** Oversample factor: coarseK = clamp(oversampleFactor * k, minCoarseK, maxCoarseK). */
  oversampleFactor: 25,
  minCoarseK: 200,
  maxCoarseK: 500,
  /** Maximum query k eligible for two-stage routing. */
  maxCoarseQueryK: 40,
  /** Maximum combined stage-1 candidates across multiple collections. */
  maxMultiCollectionCandidates: 2000,
  /** Build-time recall self-check constants. */
  selfCheckQueries: 16,
  selfCheckTopK: 10,
  selfCheckCoarseK: 200,
  selfCheckRecallFloor: 0.95,
} as const;

export type VectorRouteKind = "exact-sql" | "exact-vec0" | "coarse-bit";

export interface VectorRouteInfo {
  route: VectorRouteKind;
  /** Number of mirror rows in scope (or total partition variants when unavailable). */
  mirrorRows: number;
  /** Stage-1 coarse candidate count (coarse-bit only). */
  coarseK?: number;
  /** Distinct variants rescored in stage 2 (coarse-bit only). */
  rescored?: number;
}

export function isV2CompatibleDimensions(dimensions: number): boolean {
  return Number.isInteger(dimensions) && dimensions > 0 && dimensions % 8 === 0;
}

export function v2TableName(partitionId: string): string {
  return `vec_v2_${partitionId}`;
}

export function computeCoarseK(k: number): number {
  return Math.max(
    COARSE_ROUTER_DEFAULTS.minCoarseK,
    Math.min(
      COARSE_ROUTER_DEFAULTS.maxCoarseK,
      COARSE_ROUTER_DEFAULTS.oversampleFactor * k
    )
  );
}

export function estimateExactCostUs(
  mirrorRows: number,
  queryCount: number
): number {
  return (
    mirrorRows *
    (COARSE_ROUTER_DEFAULTS.exactFixedUsPerVec +
      COARSE_ROUTER_DEFAULTS.exactQueryUsPerVec * Math.max(1, queryCount))
  );
}

export function isPartitionAboveBudget(
  mirrorRows: number,
  queryCount = 1
): boolean {
  return (
    estimateExactCostUs(mirrorRows, queryCount) >
    COARSE_ROUTER_DEFAULTS.exactBudgetUs
  );
}

/**
 * Extract the collection scope requested by `options.eligibility`, or `[]` when
 * unscoped. Deduplicates preserving order.
 */
export function extractRequestedCollections(
  options: VectorSearchOptions
): string[] {
  const e = options.eligibility;
  if (!e) return [];
  const raw = e.collections?.length
    ? e.collections
    : e.collection
      ? [e.collection]
      : [];
  return [...new Set(raw)];
}

/**
 * Rule 1 predicate: true when ANY filter beyond `collection` / `collections` is
 * present. Matches `hasSelectiveEligibility` plus `eligibility.language` with
 * `collection`/`collections` removed, ignoring `excludeMetadata` and
 * `semanticMetadata` mode flags.
 */
export function hasNonCollectionFilter(options: VectorSearchOptions): boolean {
  if (options.allowedMirrorHashes !== undefined) return true;
  const e = options.eligibility;
  if (!e) return false;
  return Boolean(
    e.language ||
    e.memoryScopesAny?.length ||
    e.excludeSuperseded ||
    e.relPathPrefix ||
    e.tagsAll?.length ||
    e.tagsAny?.length ||
    e.since ||
    e.until ||
    e.categories?.length ||
    e.author ||
    e.filter ||
    e.exclude?.length
  );
}

// Per-connection epoch-keyed cache for indexed `vector_partition_rows` counts.
const mirrorCountCaches = new WeakMap<
  Database,
  { epoch: number; counts: Map<string, number> }
>();

function readVariantEpoch(db: Database): number | null {
  try {
    const row = db
      .query<{ epoch: number }, []>(
        "SELECT epoch FROM vector_variant_epoch WHERE id = 1"
      )
      .get();
    return row ? row.epoch : null;
  } catch {
    return null;
  }
}

/**
 * Indexed row count `N` in `vector_partition_rows` for the scanned scope
 * (unscoped, single collection, or multiple collections), cached per connection
 * on `vector_variant_epoch.epoch` when not inside an uncommitted outer tx.
 * Falls back to `vector_variants` count when `vector_partition_rows` is absent.
 */
export function countScopeMirrorRows(
  db: Database,
  partitionId: string,
  collections: readonly string[],
  hasV2Tables: boolean,
  inOuterTransaction: boolean
): number {
  const cacheKey = `${partitionId}\0${hasV2Tables ? "v2" : "v1"}\0${[...collections].sort().join("\0")}`;
  let cache: { epoch: number; counts: Map<string, number> } | undefined;
  if (!inOuterTransaction) {
    const epoch = readVariantEpoch(db);
    if (epoch !== null) {
      cache = mirrorCountCaches.get(db);
      if (cache?.epoch !== epoch || cache.counts.size > 4096) {
        cache = { epoch, counts: new Map() };
        mirrorCountCaches.set(db, cache);
      }
      const hit = cache.counts.get(cacheKey);
      if (hit !== undefined) return hit;
    }
  }

  let count = 0;
  if (hasV2Tables) {
    if (collections.length === 0) {
      count =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM vector_partition_rows WHERE partition_id = ?"
          )
          .get(partitionId)?.n ?? 0;
    } else if (collections.length === 1) {
      count =
        db
          .query<{ n: number }, [string, string]>(
            "SELECT COUNT(*) AS n FROM vector_partition_rows WHERE partition_id = ? AND collection = ?"
          )
          .get(partitionId, collections[0]!)?.n ?? 0;
    } else {
      count =
        db
          .query<{ n: number }, [string, string]>(
            `SELECT COUNT(*) AS n FROM vector_partition_rows
             WHERE partition_id = ?
               AND collection IN (SELECT value FROM json_each(?))`
          )
          .get(partitionId, JSON.stringify(collections))?.n ?? 0;
    }
  } else {
    count =
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM vector_variants WHERE partition_id = ?"
        )
        .get(partitionId)?.n ?? 0;
  }

  cache?.counts.set(cacheKey, count);
  return count;
}

export interface RouteDecisionInput {
  options: VectorSearchOptions;
  dimensions: number;
  queryCount: number;
  maxK: number;
  collections: readonly string[];
  mirrorRows: number;
  /** Whether the v2 bit mirror exists and is clean (`dirty = 0`). */
  v2MirrorClean: boolean;
  /** Stored self-check recall, or null when unchecked. */
  v2CheckRecall: number | null;
  /** Persisted null_cosine flag (0 = known none, 1 = has null, null = unknown). */
  nullCosineFlag: 0 | 1 | null;
  /** Whether existing unscoped v1 exact-vec0 fast path is eligible. */
  canUseV1ExactVec0: boolean;
}

export interface RouteDecision {
  route: VectorRouteKind;
  coarseK?: number;
  reason: string;
}

/**
 * Evaluate fn-235 router Rules 1–5 deterministically for a single or batched search.
 */
export function resolveVectorRoute(input: RouteDecisionInput): RouteDecision {
  const exactRoute: VectorRouteKind = input.canUseV1ExactVec0
    ? "exact-vec0"
    : "exact-sql";

  // Rule 1: any filter beyond collection/collections -> exact SQL scan
  if (hasNonCollectionFilter(input.options)) {
    return { route: "exact-sql", reason: "filtered" };
  }

  // Rule 2: explicit exact override, switch off, unsupported dims, missing/dirty/unchecked/below-floor v2, or null_cosine !== 0
  if (input.options.exact === true) {
    return { route: exactRoute, reason: "exact-override" };
  }
  const coarseEnabled =
    input.options.coarseVectorSearch ?? COARSE_ROUTER_DEFAULTS.enabledByDefault;
  if (!coarseEnabled) {
    return { route: exactRoute, reason: "coarse-disabled" };
  }
  if (!isV2CompatibleDimensions(input.dimensions)) {
    return { route: exactRoute, reason: "unsupported-dimensions" };
  }
  if (!input.v2MirrorClean) {
    return { route: exactRoute, reason: "v2-mirror-unavailable" };
  }
  if (
    input.v2CheckRecall === null ||
    input.v2CheckRecall < COARSE_ROUTER_DEFAULTS.selfCheckRecallFloor
  ) {
    return { route: exactRoute, reason: "v2-self-check-not-passed" };
  }
  if (input.nullCosineFlag !== 0) {
    return { route: exactRoute, reason: "null-cosine-not-zero" };
  }

  // Rule 3: estimated exact cost within 100 ms budget -> existing exact paths
  if (
    estimateExactCostUs(input.mirrorRows, input.queryCount) <=
    COARSE_ROUTER_DEFAULTS.exactBudgetUs
  ) {
    return { route: exactRoute, reason: "within-exact-budget" };
  }

  // Rule 4: k > maxCoarseQueryK (40) -> existing exact paths
  if (input.maxK > COARSE_ROUTER_DEFAULTS.maxCoarseQueryK) {
    return { route: exactRoute, reason: "k-above-max-coarse" };
  }

  const coarseK = computeCoarseK(input.maxK);

  // Multi-collection candidate cap: collections.length * coarseK > 2000 -> exact
  if (
    input.collections.length > 1 &&
    input.collections.length * coarseK >
      COARSE_ROUTER_DEFAULTS.maxMultiCollectionCandidates
  ) {
    return { route: exactRoute, reason: "multi-collection-cap" };
  }

  // Rule 5: two-stage bit coarse + exact float32 rescore
  return { route: "coarse-bit", coarseK, reason: "coarse-bit" };
}
