/**
 * Owner-aware garbage collection of stored vector variants, across every
 * stored partition (active, shadow and legacy-keyed).
 *
 * A variant is live when an active document whose content matches the
 * content of one of the variant's owner bindings (same mirror hash and chunk
 * sequence) produces the variant's exact embedding input under the
 * partition's model. That covers every valid active owner, in any
 * collection, and identical content that is active but not re-bound yet (a
 * moved file before the next embed), which embedding reuses by input hash.
 * Everything else is collectible.
 *
 * Evaluation needs only the database and the partition's stored model; it
 * never constructs a `VectorVariantStore`, whose constructor creates
 * partition and mirror state. Removal deletes the vec0 mirror rows, owner
 * bindings and variants of one batch in one transaction; the migration 028
 * triggers advance the variant epoch, which fences concurrent embedding and
 * cached proofs. Partition state and activation are never changed.
 *
 * @module src/store/vector/garbage
 */
import type { Database } from "bun:sqlite";

import { envIsSet } from "../../llm/policy";
import { formatDocForEmbedding } from "../../pipeline/contextual";
import { markMirrorClean } from "./partition-index";
import { provenOwners, vectorProofKey } from "./proof-cache";
import {
  chunkKeyHint,
  embeddingInputHash,
  ownerPartitionVariantHint,
  variantPartitionIdHint,
} from "./variants";

/** Set to disable automatic collection at the end of embed passes. */
export const AUTO_VECTOR_GC_DISABLE_ENV = "GNO_NO_AUTO_VECTOR_GC";

/** Variants evaluated per transaction. */
export const VECTOR_GC_BATCH_SIZE = 500;
/** Automatic collection: at most this many queued candidates per pass. */
export const AUTO_VECTOR_GC_MAX_CANDIDATES = 5000;
/** Automatic collection: stop starting new batches after this long. */
export const AUTO_VECTOR_GC_BUDGET_MS = 250;
/**
 * Automatic collection: a candidate is collected only once it has been
 * queued this long (7 days), so restoring identical content (a file deleted
 * and brought back, a branch switched and switched back) within it costs no
 * embedding. `gno vec gc` collects at once.
 */
export const AUTO_VECTOR_GC_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** The partition fields evaluation and removal need. */
export interface GcPartition {
  partitionId: string;
  model: string;
}

interface StoredPartitionRow {
  partition_id: string;
  model: string;
  dimensions: number;
  state: string;
  activated_epoch: number | null;
  legacy: number;
}

interface VariantRow {
  variant_id: number;
  input_hash: string;
  bytes: number;
}

interface EvidenceRow {
  variantId: number;
  documentId: number;
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
}

export interface PartitionGcResult {
  id: string;
  model: string;
  dimensions: number;
  state: "active" | "shadow";
  legacy: boolean;
  /** Variants examined in this partition. */
  examined: number;
  /** Collectible (dry run) or removed (real run) variants. */
  variants: number;
  /** Stored embedding bytes of those variants: sum(length(embedding)). */
  bytes: number;
  /** Why the partition was not processed; absent when it was. */
  skipped?: string;
}

export interface VectorGcReport {
  dryRun: boolean;
  partitions: PartitionGcResult[];
  /** Totals over processed partitions. */
  variants: number;
  bytes: number;
  /** Legacy `content_vectors` rows; excluded here, `gno cleanup` owns them. */
  legacyContentVectors: number;
  /** Database file size (page_count x page_size), unaffected by deletion. */
  databaseBytes: number;
  /** Free pages (freelist_count x page_size) SQLite reuses before growing. */
  freeBytes: number;
}

export interface QueuedGcResult {
  /** Queued candidates examined. */
  examined: number;
  /** Variants removed. */
  variants: number;
  bytes: number;
  /** Candidates past the grace remain queued for this partition. */
  remaining: boolean;
}

const tableExists = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

const mirrorTable = (partitionId: string): string => `vec_v1_${partitionId}`;

const documentsMirrorHint = (db: Database): string =>
  db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get("idx_documents_mirror_hash")
    ? " INDEXED BY idx_documents_mirror_hash"
    : "";

/** Whether automatic collection is turned off for this process. */
export function autoVectorGcDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return envIsSet(env, AUTO_VECTOR_GC_DISABLE_ENV);
}

/**
 * How removal can keep the partition's vec0 mirror in step: `"mirror"`
 * (the table exists and sqlite-vec is loaded), `"none"` (no table:
 * storage-only partition), or `"unsafe"` (a table sqlite-vec cannot write).
 */
export function mirrorAccess(
  db: Database,
  partitionId: string,
  vecLoaded: boolean
): "mirror" | "none" | "unsafe" {
  if (!tableExists(db, mirrorTable(partitionId))) return "none";
  return vecLoaded ? "mirror" : "unsafe";
}

/**
 * `strict`: a variant is live only through a valid owner (its own binding's
 * document is active and produces its input). `reuse`: also through any
 * active document with the same content that produces its input, which the
 * next embed pass binds by input hash.
 */
export type GcLiveness = "strict" | "reuse";

/**
 * Variants of `variants` with no live use in their partition. Valid owners
 * are checked first, so the same-content join only runs for the remainder.
 */
function collectible(
  db: Database,
  partition: GcPartition,
  variants: readonly VariantRow[],
  proofs: Map<string, boolean>,
  liveness: GcLiveness = "reuse"
): VariantRow[] {
  const owned = liveVariants(db, partition, variants, proofs, true);
  const rest = variants.filter((v) => !owned.has(v.variant_id));
  if (liveness === "strict" || rest.length === 0) return rest;
  const reusable = liveVariants(db, partition, rest, proofs, false);
  return rest.filter((v) => !reusable.has(v.variant_id));
}

/** Ids among `variants` with live evidence (see GcLiveness). */
function liveVariants(
  db: Database,
  partition: GcPartition,
  variants: readonly VariantRow[],
  proofs: Map<string, boolean>,
  ownDocument: boolean
): Set<number> {
  const live = new Set<number>();
  if (variants.length === 0) return live;
  const hashes = new Map(variants.map((v) => [v.variant_id, v.input_hash]));
  const documentJoin = ownDocument
    ? " ON d.id = o.document_id AND d.mirror_hash = o.mirror_hash AND d.active = 1"
    : `${documentsMirrorHint(db)} ON d.mirror_hash = o.mirror_hash AND d.active = 1`;
  const evidence = db.prepare<EvidenceRow, [string, string]>(`
    SELECT o.variant_id AS variantId, d.id AS documentId,
      o.mirror_hash AS mirrorHash, o.seq AS seq, c.text AS text, d.title AS title
    FROM vector_owners o${ownerPartitionVariantHint(db)}
    JOIN documents d${documentJoin}
    JOIN content_chunks c${chunkKeyHint(db)}
      ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    WHERE o.partition_id = ?
      AND o.variant_id IN (SELECT value FROM json_each(?))
  `);
  try {
    const ids = JSON.stringify(variants.map((v) => v.variant_id));
    for (const row of evidence.iterate(partition.partitionId, ids)) {
      if (live.has(row.variantId)) continue;
      const inputHash = hashes.get(row.variantId)!;
      const key = vectorProofKey(
        partition.model,
        row.documentId,
        row.mirrorHash,
        row.seq,
        inputHash
      );
      let valid = proofs.get(key);
      if (valid === undefined) {
        const input = formatDocForEmbedding(
          row.text,
          row.title ?? undefined,
          partition.model
        );
        valid = embeddingInputHash(input) === inputHash;
        proofs.set(key, valid);
      }
      if (valid) live.add(row.variantId);
    }
  } finally {
    evidence.finalize();
  }
  return live;
}

/**
 * Delete variants with their owner bindings and, with `"mirror"`, their vec0
 * rows. Runs inside the caller's transaction.
 */
function removeVariants(
  db: Database,
  partitionId: string,
  variantIds: readonly number[],
  access: "mirror" | "none"
): void {
  if (variantIds.length === 0) return;
  const ids = JSON.stringify(variantIds);
  if (access === "mirror")
    db.query(
      `DELETE FROM ${mirrorTable(partitionId)} WHERE variant_id IN (SELECT value FROM json_each(?))`
    ).run(ids);
  db.query(
    "DELETE FROM vector_owners WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))"
  ).run(partitionId, ids);
  db.query(
    "DELETE FROM vector_variants WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))"
  ).run(partitionId, ids);
}

const hasQueue = (db: Database): boolean =>
  tableExists(db, "vector_gc_candidates");

function dequeue(
  db: Database,
  partitionId: string,
  variantIds: readonly number[]
): void {
  if (variantIds.length === 0 || !hasQueue(db)) return;
  db.query(
    "DELETE FROM vector_gc_candidates WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))"
  ).run(partitionId, JSON.stringify(variantIds));
}

/**
 * Run `write` and leave the partition's mirror mark as it found it when the
 * write kept vec0 in step (the vector_variants triggers clear the mark on any
 * change). Without a mirror update the triggers' invalidation stands, so a
 * dirty or never-recorded mark is never certified clean.
 */
function keepingMirrorMark<T>(
  db: Database,
  partitionId: string,
  access: "mirror" | "none",
  write: () => T
): T {
  if (access !== "mirror" || !tableExists(db, "vector_mirror_state"))
    return write();
  const before =
    db
      .query<{ dirty: number }, [string]>(
        "SELECT dirty FROM vector_mirror_state WHERE partition_id = ?"
      )
      .get(partitionId)?.dirty ?? null;
  const result = write();
  if (before === 0) markMirrorClean(db, partitionId);
  else
    db.run("DELETE FROM vector_mirror_state WHERE partition_id = ?", [
      partitionId,
    ]);
  return result;
}

const variantPage = (
  db: Database,
  partitionId: string,
  after: number,
  limit: number
): VariantRow[] =>
  db
    .query<VariantRow, [string, number, number]>(
      `SELECT variant_id, input_hash, length(embedding) AS bytes
       FROM vector_variants${variantPartitionIdHint(db)}
       WHERE partition_id = ? AND variant_id > ?
       ORDER BY variant_id LIMIT ?`
    )
    .all(partitionId, after, limit);

const variantsById = (
  db: Database,
  partitionId: string,
  variantIds: readonly number[]
): VariantRow[] =>
  db
    .query<VariantRow, [string, string]>(
      `SELECT variant_id, input_hash, length(embedding) AS bytes
       FROM vector_variants${variantPartitionIdHint(db)}
       WHERE partition_id = ? AND variant_id IN (SELECT value FROM json_each(?))
       ORDER BY variant_id`
    )
    .all(partitionId, JSON.stringify(variantIds));

/**
 * Remove every variant without a valid owner (strict liveness) from one
 * partition inside the caller's transaction. The store's single-partition
 * collector and owner release delegate here: runtime-reference maintenance
 * relies on unmeasured vectors without a current owner never surviving to be
 * reused. Returns the number removed.
 */
export function collectPartitionInTransaction(
  db: Database,
  partition: GcPartition,
  access: "mirror" | "none",
  inOuterTx: boolean
): number {
  const proofs = provenOwners(db, inOuterTx);
  const remove: number[] = [];
  let after = 0;
  for (;;) {
    const page = variantPage(
      db,
      partition.partitionId,
      after,
      VECTOR_GC_BATCH_SIZE
    );
    if (page.length === 0) break;
    after = page.at(-1)!.variant_id;
    for (const v of collectible(db, partition, page, proofs, "strict"))
      remove.push(v.variant_id);
  }
  removeVariants(db, partition.partitionId, remove, access);
  dequeue(db, partition.partitionId, remove);
  return remove.length;
}

function storedPartitions(db: Database): StoredPartitionRow[] {
  if (!tableExists(db, "vector_partitions")) return [];
  return db
    .query<StoredPartitionRow, []>(
      `SELECT partition_id, model, dimensions, state, activated_epoch, legacy
       FROM vector_partitions ORDER BY model, partition_id`
    )
    .all();
}

function sizeReport(db: Database): {
  databaseBytes: number;
  freeBytes: number;
} {
  const pageSize =
    db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ??
    0;
  const pages =
    db.query<{ page_count: number }, []>("PRAGMA page_count").get()
      ?.page_count ?? 0;
  const free =
    db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
      ?.freelist_count ?? 0;
  return { databaseBytes: pages * pageSize, freeBytes: free * pageSize };
}

const legacyVectorCount = (db: Database): number =>
  tableExists(db, "content_vectors")
    ? (db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM content_vectors")
        .get()?.n ?? 0)
    : 0;

/**
 * Collect (or, with `dryRun`, count) unowned variants in every stored
 * partition. A dry run reads one snapshot and writes nothing; it works on a
 * read-only connection and on any schema with vector partitions. A real run
 * expects the caller to hold the index write lease and processes each
 * partition in bounded batches, each its own immediate transaction that
 * re-selects and re-validates its variants.
 */
export function runVectorGc(
  db: Database,
  options: { dryRun: boolean; vecLoaded: boolean; batchSize?: number }
): VectorGcReport {
  const batchSize = options.batchSize ?? VECTOR_GC_BATCH_SIZE;
  const evaluatePartition = (row: StoredPartitionRow): PartitionGcResult => {
    const result: PartitionGcResult = {
      id: row.partition_id,
      model: row.model,
      dimensions: row.dimensions,
      state:
        row.state === "active" && row.activated_epoch !== null
          ? "active"
          : "shadow",
      legacy: row.legacy === 1,
      examined: 0,
      variants: 0,
      bytes: 0,
    };
    const access = mirrorAccess(db, row.partition_id, options.vecLoaded);
    if (access === "unsafe") {
      result.skipped =
        "sqlite-vec is unavailable; its vec0 index cannot be kept in step";
      return result;
    }
    const partition = { partitionId: row.partition_id, model: row.model };
    let after = 0;
    for (;;) {
      const batch = (): VariantRow[] => {
        const page = variantPage(db, row.partition_id, after, batchSize);
        if (page.length === 0) return page;
        after = page.at(-1)!.variant_id;
        result.examined += page.length;
        // Never inside a caller's transaction: the shared proof cache is safe.
        const proofs = provenOwners(db, false);
        const garbage = collectible(db, partition, page, proofs);
        for (const v of garbage) {
          result.variants += 1;
          result.bytes += v.bytes;
        }
        if (!options.dryRun) {
          const ids = garbage.map((v) => v.variant_id);
          keepingMirrorMark(db, row.partition_id, access, () =>
            removeVariants(db, row.partition_id, ids, access)
          );
          dequeue(
            db,
            row.partition_id,
            page.map((v) => v.variant_id)
          );
        }
        return page;
      };
      const page = options.dryRun ? batch() : db.transaction(batch).immediate();
      if (page.length < batchSize) break;
    }
    if (!options.dryRun && hasQueue(db))
      db.transaction(() => {
        db.run(
          `DELETE FROM vector_gc_candidates WHERE partition_id = ? AND NOT EXISTS (
            SELECT 1 FROM vector_variants v
            WHERE v.partition_id = vector_gc_candidates.partition_id
              AND v.variant_id = vector_gc_candidates.variant_id)`,
          [row.partition_id]
        );
      }).immediate();
    return result;
  };

  const run = (): VectorGcReport => {
    const partitions = storedPartitions(db).map(evaluatePartition);
    if (!options.dryRun && hasQueue(db))
      db.transaction(() => {
        db.run(
          `DELETE FROM vector_gc_candidates WHERE partition_id NOT IN (
            SELECT partition_id FROM vector_partitions)`
        );
      }).immediate();
    return {
      dryRun: options.dryRun,
      partitions,
      variants: partitions.reduce((sum, p) => sum + p.variants, 0),
      bytes: partitions.reduce((sum, p) => sum + p.bytes, 0),
      legacyContentVectors: legacyVectorCount(db),
      ...sizeReport(db),
    };
  };
  // A dry run reads every partition in one snapshot.
  return options.dryRun ? db.transaction(run).deferred() : run();
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * One indexed probe: does this partition have candidates queued at or before
 * `dueAt` (unix seconds; default now, i.e. any queued candidate)?
 */
export function hasQueuedGarbage(
  db: Database,
  partitionId: string,
  dueAt: number = nowSeconds()
): boolean {
  if (!hasQueue(db)) return false;
  return !!db
    .query<unknown, [string, number]>(
      "SELECT 1 FROM vector_gc_candidates WHERE partition_id = ? AND queued_at <= ? LIMIT 1"
    )
    .get(partitionId, dueAt);
}

/**
 * Examine this partition's queued candidates older than `graceSeconds` in
 * bounded batches, each its own immediate transaction, and remove the
 * collectible ones. Stops after `maxCandidates` candidates or once
 * `budgetMs` has elapsed; the rest stay queued for the next call. Candidates
 * inside the grace stay queued untouched, so restoring identical content
 * within it reuses the stored vector. The caller holds the index write lease.
 */
export function collectQueuedGarbage(
  db: Database,
  partition: GcPartition,
  options: {
    vecLoaded: boolean;
    batchSize?: number;
    maxCandidates?: number;
    budgetMs?: number;
    graceSeconds?: number;
  }
): QueuedGcResult {
  const batchSize = options.batchSize ?? VECTOR_GC_BATCH_SIZE;
  const maxCandidates = options.maxCandidates ?? AUTO_VECTOR_GC_MAX_CANDIDATES;
  const budgetMs = options.budgetMs ?? AUTO_VECTOR_GC_BUDGET_MS;
  const dueAt =
    nowSeconds() - (options.graceSeconds ?? AUTO_VECTOR_GC_GRACE_SECONDS);
  const result: QueuedGcResult = {
    examined: 0,
    variants: 0,
    bytes: 0,
    remaining: false,
  };
  if (!hasQueue(db)) return result;
  const access = mirrorAccess(db, partition.partitionId, options.vecLoaded);
  if (access === "unsafe")
    throw new Error(
      "sqlite-vec is unavailable; cannot collect vectors from an existing vec0 index"
    );
  const startedAt = performance.now();
  while (
    result.examined < maxCandidates &&
    performance.now() - startedAt < budgetMs
  ) {
    const examined = db
      .transaction((): number => {
        let ids = db
          .query<{ variant_id: number }, [string, number, number]>(
            `SELECT variant_id FROM vector_gc_candidates
             WHERE partition_id = ? AND queued_at <= ?
             ORDER BY queued_at LIMIT ?`
          )
          .all(
            partition.partitionId,
            dueAt,
            Math.min(batchSize, maxCandidates - result.examined)
          )
          .map((row) => row.variant_id);
        if (ids.length === 0) return 0;
        ids = [...new Set(ids)];
        const garbage = collectible(
          db,
          partition,
          variantsById(db, partition.partitionId, ids),
          provenOwners(db, false)
        );
        keepingMirrorMark(db, partition.partitionId, access, () =>
          removeVariants(
            db,
            partition.partitionId,
            garbage.map((v) => v.variant_id),
            access
          )
        );
        // Owner deletes above re-queue their variants; clear every examined id.
        dequeue(db, partition.partitionId, ids);
        for (const v of garbage) {
          result.variants += 1;
          result.bytes += v.bytes;
        }
        return ids.length;
      })
      .immediate();
    if (examined === 0) break;
    result.examined += examined;
  }
  result.remaining = hasQueuedGarbage(db, partition.partitionId, dueAt);
  return result;
}
