/** Read-only coverage of persisted variant authority; never initializes models. */
import type { Database } from "bun:sqlite";

import { getEmbeddingFingerprint } from "../../embed/fingerprint";
import { formatDocForEmbedding } from "../../pipeline/contextual";
import { currentOwnerCount } from "./runtime-compat";
import {
  embeddingInputHash,
  loadSqliteVec,
  SELECTED_VECTOR_PARTITION_PREFIX,
} from "./variants";

interface Partition {
  partition_id: string;
  version: number;
  model: string;
  fingerprint: string;
  dimensions: number;
  state: string;
  activated_epoch: number | null;
  legacy: number;
  provenance: string | null;
  fork: string | null;
}

export interface VectorPartitionStatus {
  id: string;
  model: string;
  dimensions: number;
  state: "active" | "shadow";
  /** Pre-fn-184 runtime-keyed partition awaiting measured re-keying. */
  legacy: boolean;
  /**
   * Status counts use this partition: the activated runtime-independent one
   * every compatible runtime reads. Each runtime reads the partition that lists
   * it in `compatibleRuntimes`.
   */
  retrieval: boolean;
  /** Current document chunks bound to this partition. */
  owners: number;
  /** Runtime that built the partition, e.g. "CUDA, Bun 1.4.2". */
  provenance: string;
  /** Runtimes measured (or recorded as the builder) to read this partition. */
  compatibleRuntimes: string[];
  /** Runtimes measured incompatible; they need another partition or lexical. */
  incompatibleRuntimes: string[];
}

const activated = (p: Partition): boolean =>
  p.state === "active" && p.activated_epoch !== null;

/**
 * The partition status reports against: the activated primary (shared by all
 * compatible runtimes) first, then an activated confirmed fork, then an
 * activated legacy one, so an incomplete shadow never reads as lost embeddings.
 * The last embedding selection, then coverage, breaks ties within a tier.
 */
function retrievalPartition(
  db: Database,
  candidates: Partition[],
  selection: string | undefined
): Partition | undefined {
  for (const tier of [
    candidates.filter((p) => activated(p) && !p.legacy && !p.fork),
    candidates.filter((p) => activated(p) && !p.legacy),
    candidates.filter(activated),
  ]) {
    if (!tier.length) continue;
    const selected = tier.find((p) => p.partition_id === selection);
    if (selected) return selected;
    let best = tier[0]!;
    let bestOwners = currentOwnerCount(db, best.partition_id);
    for (const partition of tier.slice(1)) {
      const owners = currentOwnerCount(db, partition.partition_id);
      if (owners > bestOwners) [best, bestOwners] = [partition, owners];
    }
    return best;
  }
  return selection === undefined
    ? candidates.length === 1
      ? candidates[0]
      : undefined
    : candidates.find((p) => p.partition_id === selection);
}

function readPartitions(db: Database, model: string | null): Partition[] {
  return db
    .query<Partition, [string | null, string | null]>(`
      SELECT partition_id, version, model, fingerprint, dimensions, state,
        activated_epoch, legacy, provenance, fork
      FROM vector_partitions WHERE (? IS NULL OR model = ?)
      ORDER BY model, partition_id
    `)
    .all(model, model);
}

function readSelections(db: Database): Map<string, string> {
  return new Map(
    db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM schema_meta WHERE key GLOB ?"
      )
      .all(`${SELECTED_VECTOR_PARTITION_PREFIX}*`)
      .map((row) => [
        row.key.slice(SELECTED_VECTOR_PARTITION_PREFIX.length),
        row.value,
      ])
  );
}

function hasPartitionTable(db: Database): boolean {
  return !!db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
    )
    .get();
}

/** Every partition with its state, owners and provenance (R4). */
export function listVectorPartitions(
  db: Database,
  model?: string
): VectorPartitionStatus[] {
  return db.transaction(() => {
    if (!hasPartitionTable(db)) return [];
    const partitions = readPartitions(db, model ?? null);
    const selected = readSelections(db);
    const retrieval = new Set<string>();
    for (const name of new Set(partitions.map((p) => p.model))) {
      const chosen = retrievalPartition(
        db,
        partitions.filter((p) => p.model === name),
        selected.get(name)
      );
      if (chosen) retrieval.add(chosen.partition_id);
    }
    const runtimes = db.prepare<{ label: string }, [string, string]>(
      "SELECT DISTINCT label FROM vector_runtime_verdicts WHERE partition_id = ? AND verdict = ? ORDER BY label"
    );
    return partitions.map(
      (p): VectorPartitionStatus => ({
        id: p.partition_id,
        model: p.model,
        dimensions: p.dimensions,
        state: activated(p) ? "active" : "shadow",
        legacy: p.legacy === 1,
        retrieval: retrieval.has(p.partition_id),
        owners: currentOwnerCount(db, p.partition_id),
        provenance:
          p.provenance ??
          (p.legacy ? "unrecorded (pre-fn-184 key)" : "unrecorded"),
        compatibleRuntimes: runtimes
          .all(p.partition_id, "compatible")
          .map((row) => row.label),
        incompatibleRuntimes: runtimes
          .all(p.partition_id, "incompatible")
          .map((row) => row.label),
      })
    );
  })();
}

interface OwnerCoverage {
  document_id: number;
  partition_id: string | null;
  collection: string;
  mirror_hash: string;
  seq: number;
  text: string;
  title: string | null;
  input_hash: string | null;
  embedding_bytes: number | null;
  legacy_embedded: number;
}

/** Null retains legacy counts until a verified selection or activation exists. */
export function getVariantStatus(
  db: Database,
  options?: { embedModel?: string; embedFingerprint?: string }
): { backlog: number; embeddedByCollection: Map<string, number> } | null {
  return db.transaction(() => {
    if (!hasPartitionTable(db)) return null;
    const partitions = readPartitions(db, options?.embedModel ?? null);
    const selected = readSelections(db);
    const models = new Set(partitions.map((p) => p.model));
    if (options?.embedModel) models.add(options.embedModel);
    else for (const model of selected.keys()) models.add(model);
    const authoritativeModels = new Set<string>();
    const usablePartitions = new Map<string, Partition>();
    for (const model of models) {
      const candidates = partitions.filter((p) => p.model === model);
      const selection = selected.get(model);
      if (selection === undefined && !candidates.some(activated)) continue;
      authoritativeModels.add(model);
      // Resolve one persisted identity per model, never combine alternative
      // partitions of the same model. Unscoped status may accept any model.
      // Stale epochs do not revoke owners whose current inputs still match.
      const partition = retrievalPartition(db, candidates, selection);
      if (
        partition &&
        partition.version === 1 &&
        partition.partition_id ===
          embeddingInputHash(
            JSON.stringify([
              partition.model,
              partition.fingerprint,
              partition.dimensions,
            ])
          ) &&
        (options?.embedFingerprint === undefined ||
          options.embedFingerprint ===
            getEmbeddingFingerprint({
              modelUri: partition.model,
              dimensions: partition.dimensions,
            }))
      )
        usablePartitions.set(partition.partition_id, partition);
    }
    if (authoritativeModels.size === 0) return null;
    // Unscoped legacy coverage remains valid only for models that have never
    // selected or activated verified authority; legacy rows cannot repair it.
    const statement = db.prepare<
      OwnerCoverage,
      [string | null, string, string]
    >(`
      WITH legacy_vectors AS (
        SELECT mirror_hash, seq, MAX(embedded_at) AS embedded_at
        FROM content_vectors
        WHERE ? IS NULL AND model NOT IN (SELECT value FROM json_each(?))
        GROUP BY mirror_hash, seq
      )
      SELECT d.id AS document_id, o.partition_id, d.collection, d.mirror_hash, c.seq, c.text, d.title,
        v.input_hash, length(v.embedding) AS embedding_bytes,
        CASE WHEN lv.embedded_at >= c.created_at THEN 1 ELSE 0 END AS legacy_embedded
      FROM documents d
      JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      LEFT JOIN vector_owners o ON o.document_id = d.id AND o.seq = c.seq
        AND o.mirror_hash = d.mirror_hash
        AND o.partition_id IN (SELECT value FROM json_each(?))
      LEFT JOIN vector_variants v ON v.variant_id = o.variant_id
        AND v.partition_id = o.partition_id
      LEFT JOIN legacy_vectors lv ON lv.mirror_hash = c.mirror_hash AND lv.seq = c.seq
      WHERE d.active = 1
    `);
    const owners = new Map<
      string,
      { collection: string; chunk: string; embedded: boolean }
    >();
    try {
      for (const row of statement.iterate(
        options?.embedModel ?? null,
        JSON.stringify([...authoritativeModels]),
        JSON.stringify([...usablePartitions.keys()])
      )) {
        const partition = row.partition_id
          ? usablePartitions.get(row.partition_id)
          : undefined;
        const embedded = Boolean(
          row.legacy_embedded ||
          (partition &&
            row.embedding_bytes ===
              partition.dimensions * Float32Array.BYTES_PER_ELEMENT &&
            row.input_hash ===
              embeddingInputHash(
                formatDocForEmbedding(
                  row.text,
                  row.title ?? undefined,
                  partition.model
                )
              ))
        );
        const key = `${row.document_id}:${row.seq}`;
        const previous = owners.get(key);
        if (previous) previous.embedded ||= embedded;
        else
          owners.set(key, {
            collection: row.collection,
            chunk: JSON.stringify([row.mirror_hash, row.seq]),
            embedded,
          });
      }
    } finally {
      statement.finalize();
    }
    const collections = new Map<string, Map<string, boolean>>();
    let backlog = 0;
    for (const owner of owners.values()) {
      if (!owner.embedded) backlog++;
      let chunks = collections.get(owner.collection);
      if (!chunks) {
        chunks = new Map();
        collections.set(owner.collection, chunks);
      }
      // Distinct collection chunks are ready only when every active owner is.
      chunks.set(
        owner.chunk,
        (chunks.get(owner.chunk) ?? true) && owner.embedded
      );
    }
    const embeddedByCollection = new Map<string, number>();
    for (const [collection, chunks] of collections) {
      let count = 0;
      for (const embedded of chunks.values()) if (embedded) count++;
      embeddedByCollection.set(collection, count);
    }
    return { backlog, embeddedByCollection };
  })();
}

const MIN_PARTITION_PREFIX = 8;

type DropResult =
  | { ok: true; partition: VectorPartitionStatus }
  | { ok: false; error: string };

/**
 * Remove an abandoned partition (shadow or legacy) with its vectors, owners and
 * verdicts. The partition status and retrieval use, and any activated
 * runtime-independent partition, are refused.
 */
export async function dropVectorPartition(
  db: Database,
  idPrefix: string
): Promise<DropResult> {
  if (idPrefix.length < MIN_PARTITION_PREFIX)
    return {
      ok: false,
      error: `Give at least ${MIN_PARTITION_PREFIX} characters of the partition id (see \`gno status\`)`,
    };
  const vecLoaded = await loadSqliteVec(db);
  return db
    .transaction((): DropResult => {
      const matches = listVectorPartitions(db).filter((p) =>
        p.id.startsWith(idPrefix)
      );
      const [partition] = matches;
      if (!partition || matches.length > 1)
        return {
          ok: false,
          error: matches.length
            ? `Partition id prefix ${idPrefix} is ambiguous`
            : `No vector partition ${idPrefix}`,
        };
      if (
        partition.retrieval ||
        (partition.state === "active" && !partition.legacy)
      )
        return {
          ok: false,
          error: `Refusing to drop partition ${partition.id.slice(0, 12)}: it is active and used by retrieval`,
        };
      const table = `vec_v1_${partition.id}`;
      if (
        !vecLoaded &&
        db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)
      )
        return {
          ok: false,
          error:
            "sqlite-vec is unavailable; cannot drop the vector index table",
        };
      for (const statement of [
        "DELETE FROM vector_owners WHERE partition_id = ?",
        "DELETE FROM vector_variants WHERE partition_id = ?",
        "DELETE FROM vector_runtime_verdicts WHERE partition_id = ?",
        "DELETE FROM vector_partitions WHERE partition_id = ?",
        `DELETE FROM schema_meta WHERE key GLOB '${SELECTED_VECTOR_PARTITION_PREFIX}*' AND value = ?`,
      ])
        db.run(statement, [partition.id]);
      db.exec(`DROP TABLE IF EXISTS ${table}`);
      return { ok: true, partition };
    })
    .immediate();
}
