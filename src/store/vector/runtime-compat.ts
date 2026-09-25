/**
 * Measured runtime compatibility for vector partitions (fn-184).
 *
 * Partition identity is model weights + formatter + dimensions + context and
 * truncation policy. A runtime (Bun, native binding, backend, threads) may use
 * a partition only after re-embedding a small sample of its stored chunks
 * reproduces the stored vectors. The verdict is cached per (partition, runtime).
 *
 * @module src/store/vector/runtime-compat
 */

import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../../llm/types";
import type { VectorVariantIdentity } from "./types";

import { getVariantModelFingerprint } from "../../embed/fingerprint";
import { formatDocForEmbedding } from "../../pipeline/contextual";
import { decodeEmbedding } from "./sqlite-vec";
import {
  embeddingInputHash,
  loadSqliteVec,
  SELECTED_VECTOR_PARTITION_PREFIX,
  vectorPartitionId,
  vectorVariantFingerprint,
} from "./variants";

/**
 * Every sampled chunk must reach this cosine. Measured (spec fn-184): Bun
 * version and CPU threads were bit-identical, GPU vs CPU min 0.99937, two
 * different chunks of one corpus reached 0.951.
 */
export const RUNTIME_MIN_COSINE = 0.99;
export const RUNTIME_SAMPLE_SIZE = 8;

export type RuntimeVerdict = "compatible" | "incompatible" | "unverified";

interface VerdictRow {
  verdict: "compatible" | "incompatible";
  min_cosine: number;
  samples: number;
  sample_ms: number;
}

interface Runtime {
  fingerprint: string;
  label: string;
}

export interface RuntimePartition {
  /** Partition this runtime reads and writes. */
  identity: VectorVariantIdentity;
  verdict: RuntimeVerdict;
  /**
   * Set when this runtime must not use `identity`: building `separate` is a
   * new partition and needs explicit confirmation.
   */
  blocked?: { reason: string; separate: VectorVariantIdentity };
  /** Measured embedding cost from the compatibility sample, when one ran. */
  msPerChunk?: number;
}

/** Effective partition identity of an initialized verified port. */
export function embeddingPartitionIdentity(
  port: EmbeddingPort
): VectorVariantIdentity | undefined {
  const identity = port.getIdentity?.();
  if (!identity) return undefined;
  const dimensions = port.dimensions();
  return {
    model: port.modelUri,
    modelFingerprint: getVariantModelFingerprint(
      { modelUri: port.modelUri, dimensions },
      identity
    ),
    contextSize: identity.contextSize,
    truncationPolicy: identity.truncationPolicy,
    dimensions,
  };
}

export function identityPartitionId(identity: VectorVariantIdentity): string {
  return vectorPartitionId(
    identity.model,
    vectorVariantFingerprint(identity),
    identity.dimensions
  );
}

function partitionExists(db: Database, partitionId: string): boolean {
  return !!db
    .query("SELECT 1 FROM vector_partitions WHERE partition_id = ?")
    .get(partitionId);
}

/** Current owners bound to a partition; the completeness measure. */
export function currentOwnerCount(db: Database, partitionId: string): number {
  return db
    .query<{ count: number }, [string]>(`
      SELECT count(*) AS count FROM vector_owners o
      JOIN documents d ON d.id = o.document_id AND d.active = 1
        AND d.mirror_hash = o.mirror_hash
      WHERE o.partition_id = ?
    `)
    .get(partitionId)!.count;
}

/** First stored variants (by id) whose current owner still yields the stored input. */
function sampleStored(
  db: Database,
  partitionId: string,
  model: string
): { input: string; embedding: Float32Array }[] {
  const statement = db.prepare<
    {
      text: string;
      title: string | null;
      input_hash: string;
      embedding: Uint8Array;
    },
    [string]
  >(`
    SELECT c.text, d.title, v.input_hash, v.embedding FROM vector_variants v
    JOIN vector_owners o ON o.partition_id = v.partition_id AND o.variant_id = v.variant_id
    JOIN documents d ON d.id = o.document_id AND d.active = 1 AND d.mirror_hash = o.mirror_hash
    JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
    WHERE v.partition_id = ? ORDER BY v.variant_id
  `);
  const sample = new Map<string, { input: string; embedding: Float32Array }>();
  try {
    for (const row of statement.iterate(partitionId)) {
      const input = formatDocForEmbedding(
        row.text,
        row.title ?? undefined,
        model
      );
      if (embeddingInputHash(input) !== row.input_hash) continue;
      sample.set(row.input_hash, {
        input,
        embedding: decodeEmbedding(row.embedding),
      });
      if (sample.size === RUNTIME_SAMPLE_SIZE) break;
    }
  } finally {
    statement.finalize();
  }
  return [...sample.values()];
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Cached verdict, or a fresh measured one. Throws only on embedding failure. */
async function verdictFor(
  db: Database,
  port: EmbeddingPort,
  partitionId: string,
  model: string,
  runtime: Runtime
): Promise<{ verdict: RuntimeVerdict; msPerChunk?: number }> {
  const cached = db
    .query<VerdictRow, [string, string]>(
      "SELECT verdict, min_cosine, samples, sample_ms FROM vector_runtime_verdicts WHERE partition_id = ? AND runtime = ?"
    )
    .get(partitionId, runtime.fingerprint);
  if (cached)
    return {
      verdict: cached.verdict,
      msPerChunk: cached.samples
        ? cached.sample_ms / cached.samples
        : undefined,
    };
  const sample = sampleStored(db, partitionId, model);
  if (!sample.length) return { verdict: "unverified" };
  const startedAt = performance.now();
  const result = await port.embedBatch(sample.map((entry) => entry.input));
  if (!result.ok) throw new Error(result.error.message);
  const sampleMs = performance.now() - startedAt;
  let minCosine = 1;
  for (const [index, entry] of sample.entries()) {
    const fresh = result.value[index];
    minCosine = Math.min(
      minCosine,
      fresh && fresh.length === entry.embedding.length
        ? cosine(fresh, entry.embedding)
        : 0
    );
  }
  const verdict =
    minCosine >= RUNTIME_MIN_COSINE ? "compatible" : "incompatible";
  try {
    db.run(
      `INSERT OR REPLACE INTO vector_runtime_verdicts
      (partition_id, runtime, label, verdict, min_cosine, samples, sample_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        partitionId,
        runtime.fingerprint,
        runtime.label,
        verdict,
        minCosine,
        sample.length,
        sampleMs,
      ]
    );
  } catch {
    // The measured verdict still applies to this run; the next run re-measures.
  }
  return { verdict, msPerChunk: sampleMs / sample.length };
}

interface LegacyPartition {
  partition_id: string;
  activated: number;
}

type LegacyOutcome =
  | { kind: "none" }
  | { kind: "rekeyed"; msPerChunk?: number }
  | { kind: "blocked"; reason: string; msPerChunk?: number };

/**
 * One-time migration: re-key the most complete compatible pre-fn-184 partition
 * under the runtime-independent key and keep the others as shadow. Idempotent
 * (re-keyed rows are no longer legacy) and atomic (one immediate transaction).
 */
async function rekeyLegacy(
  db: Database,
  port: EmbeddingPort,
  primary: VectorVariantIdentity,
  runtime: Runtime
): Promise<LegacyOutcome> {
  const legacy = db
    .query<LegacyPartition, [string, number]>(`
      SELECT partition_id, activated_epoch IS NOT NULL AND state = 'active' AS activated
      FROM vector_partitions WHERE legacy = 1 AND model = ? AND dimensions = ?
      ORDER BY partition_id
    `)
    .all(primary.model, primary.dimensions);
  if (!legacy.length) return { kind: "none" };
  const compatible: (LegacyPartition & { owners: number })[] = [];
  let msPerChunk: number | undefined;
  for (const partition of legacy) {
    const measured = await verdictFor(
      db,
      port,
      partition.partition_id,
      primary.model,
      runtime
    );
    msPerChunk ??= measured.msPerChunk;
    if (measured.verdict === "compatible")
      compatible.push({
        ...partition,
        owners: currentOwnerCount(db, partition.partition_id),
      });
  }
  compatible.sort((a, b) => b.activated - a.activated || b.owners - a.owners);
  const [winner, runnerUp] = compatible;
  if (!winner)
    return {
      kind: "blocked",
      reason: `none of the ${legacy.length} existing partition(s) reproduces its stored vectors under ${runtime.label}`,
      msPerChunk,
    };
  if (
    runnerUp &&
    runnerUp.activated === winner.activated &&
    runnerUp.owners === winner.owners
  )
    return {
      kind: "blocked",
      reason: `ambiguous migration: partitions ${compatible
        .filter(
          (p) => p.activated === winner.activated && p.owners === winner.owners
        )
        .map((p) => p.partition_id.slice(0, 12))
        .join(
          ", "
        )} are equally complete; all were kept. Drop all but one with \`gno vec drop <partition>\``,
      msPerChunk,
    };
  if (!(await loadSqliteVec(db)))
    return {
      kind: "blocked",
      reason:
        "sqlite-vec is unavailable; existing partitions cannot be re-keyed",
      msPerChunk,
    };
  const newId = identityPartitionId(primary);
  const oldId = winner.partition_id;
  db.transaction(() => {
    // A concurrent process may have finished the migration first.
    if (
      partitionExists(db, newId) ||
      !db
        .query(
          "SELECT 1 FROM vector_partitions WHERE partition_id = ? AND legacy = 1"
        )
        .get(oldId)
    )
      return;
    db.run("PRAGMA defer_foreign_keys = ON");
    db.run(
      `INSERT INTO vector_partitions
      (partition_id, version, model, fingerprint, dimensions, state, activated_epoch, provenance, legacy)
      SELECT ?, version, model, ?, dimensions, state, activated_epoch, provenance, 0
      FROM vector_partitions WHERE partition_id = ?`,
      [newId, vectorVariantFingerprint(primary), oldId]
    );
    for (const table of [
      "vector_variants",
      "vector_owners",
      "vector_runtime_verdicts",
    ])
      db.run(`UPDATE ${table} SET partition_id = ? WHERE partition_id = ?`, [
        newId,
        oldId,
      ]);
    db.run("UPDATE schema_meta SET value = ? WHERE key GLOB ? AND value = ?", [
      newId,
      `${SELECTED_VECTOR_PARTITION_PREFIX}*`,
      oldId,
    ]);
    db.run("DELETE FROM vector_partitions WHERE partition_id = ?", [oldId]);
    db.run(
      `UPDATE vector_partitions SET state = 'shadow', activated_epoch = NULL
      WHERE legacy = 1 AND model = ? AND dimensions = ?`,
      [primary.model, primary.dimensions]
    );
    // vec0 cannot be renamed; rebuild the materialized index from stored blobs.
    db.exec(`CREATE VIRTUAL TABLE vec_v1_${newId} USING vec0(
      variant_id INTEGER PRIMARY KEY,
      embedding FLOAT[${primary.dimensions}] distance_metric=cosine
    )`);
    db.run(
      `INSERT INTO vec_v1_${newId}(variant_id, embedding)
      SELECT variant_id, embedding FROM vector_variants WHERE partition_id = ?`,
      [newId]
    );
    db.exec(`DROP TABLE IF EXISTS vec_v1_${oldId}`);
  }).immediate();
  return { kind: "rekeyed", msPerChunk };
}

/**
 * Resolve the partition an initialized verified runtime may use. Runs the
 * one-time legacy migration and the measured check on first contact.
 */
export async function resolveRuntimePartition(
  db: Database,
  port: EmbeddingPort,
  primary: VectorVariantIdentity
): Promise<RuntimePartition> {
  const identity = port.getIdentity?.();
  if (!identity) throw new Error("Verified embedding identity required");
  const runtime: Runtime = {
    fingerprint: identity.runtimeFingerprint,
    label: identity.runtimeLabel ?? "unknown runtime",
  };
  const fork = { ...primary, fork: runtime.fingerprint };
  // An explicitly confirmed separate partition belongs to this runtime alone.
  if (partitionExists(db, identityPartitionId(fork)))
    return { identity: fork, verdict: "compatible" };
  const primaryId = identityPartitionId(primary);
  if (!partitionExists(db, primaryId)) {
    const legacy = await rekeyLegacy(db, port, primary, runtime);
    if (legacy.kind === "blocked")
      return {
        identity: primary,
        verdict: "incompatible",
        blocked: { reason: legacy.reason, separate: primary },
        msPerChunk: legacy.msPerChunk,
      };
    if (legacy.kind === "none")
      return { identity: primary, verdict: "unverified" };
  }
  const measured = await verdictFor(
    db,
    port,
    primaryId,
    primary.model,
    runtime
  );
  if (measured.verdict !== "incompatible")
    return { identity: primary, ...measured };
  return {
    identity: primary,
    ...measured,
    blocked: {
      reason: `${runtime.label} does not reproduce the stored vectors (cosine below ${RUNTIME_MIN_COSINE})`,
      separate: fork,
    },
  };
}

/**
 * A runtime that writes into a partition with no samplable vectors defines its
 * reference: verdicts measured against vectors that no longer exist are void.
 * Best effort, like any verdict write (R1).
 */
export function recordReferenceRuntime(
  db: Database,
  partitionId: string,
  identity: { runtimeFingerprint: string; runtimeLabel?: string }
): void {
  try {
    db.transaction(() => {
      db.run("DELETE FROM vector_runtime_verdicts WHERE partition_id = ?", [
        partitionId,
      ]);
      db.run(
        `INSERT INTO vector_runtime_verdicts
        (partition_id, runtime, label, verdict, min_cosine, samples, sample_ms)
        VALUES (?, ?, ?, 'compatible', 1, 0, 0)`,
        [
          partitionId,
          identity.runtimeFingerprint,
          identity.runtimeLabel ?? "unknown runtime",
        ]
      );
    }).immediate();
  } catch {
    // The next run measures instead.
  }
}

/** Partition authority is durable once activated (see VectorVariantStore.hasActivated). */
export function isPartitionActivated(
  db: Database,
  partitionId: string
): boolean {
  return !!db
    .query(
      "SELECT 1 FROM vector_partitions WHERE partition_id = ? AND state = 'active' AND activated_epoch IS NOT NULL"
    )
    .get(partitionId);
}
