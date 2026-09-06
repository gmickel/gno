/** Read-only coverage of persisted variant authority; never initializes models. */
import type { Database } from "bun:sqlite";

import { getEmbeddingFingerprint } from "../../embed/fingerprint";
import { formatDocForEmbedding } from "../../pipeline/contextual";
import {
  embeddingInputHash,
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
}

/** Null retains legacy counts until a verified selection or activation exists. */
export function getVariantStatus(
  db: Database,
  options?: { embedModel?: string; embedFingerprint?: string }
): { backlog: number; embeddedByCollection: Map<string, number> } | null {
  return db.transaction(() => {
    if (
      !db
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
        )
        .get()
    )
      return null;
    const partitions = db
      .query<Partition, [string | null, string | null]>(`
        SELECT partition_id, version, model, fingerprint, dimensions, state, activated_epoch
        FROM vector_partitions WHERE (? IS NULL OR model = ?)
      `)
      .all(options?.embedModel ?? null, options?.embedModel ?? null);
    const selections = db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM schema_meta WHERE key GLOB ?"
      )
      .all(`${SELECTED_VECTOR_PARTITION_PREFIX}*`);
    const selected = new Map(
      selections.map((row) => [
        row.key.slice(SELECTED_VECTOR_PARTITION_PREFIX.length),
        row.value,
      ])
    );
    const models = new Set(partitions.map((p) => p.model));
    if (options?.embedModel) models.add(options.embedModel);
    else for (const model of selected.keys()) models.add(model);
    let hasAuthority = false;
    const usablePartitions = new Map<string, Partition>();
    for (const model of models) {
      const candidates = partitions.filter((p) => p.model === model);
      const selection = selected.get(model);
      const activated = candidates.some(
        (p) => p.state === "active" && p.activated_epoch !== null
      );
      if (selection === undefined && !activated) continue;
      hasAuthority = true;
      // Resolve one persisted identity per model, never combine alternative
      // partitions of the same model. Unscoped status may accept any model.
      // Stale epochs do not revoke owners whose current inputs still match.
      const partition =
        selection === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((p) => p.partition_id === selection);
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
    if (!hasAuthority) return null;
    const statement = db.prepare<OwnerCoverage, [string]>(`
      SELECT d.id AS document_id, o.partition_id, d.collection, d.mirror_hash, c.seq, c.text, d.title,
        v.input_hash, length(v.embedding) AS embedding_bytes
      FROM documents d
      JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      LEFT JOIN vector_owners o ON o.document_id = d.id AND o.seq = c.seq
        AND o.mirror_hash = d.mirror_hash
        AND o.partition_id IN (SELECT value FROM json_each(?))
      LEFT JOIN vector_variants v ON v.variant_id = o.variant_id
        AND v.partition_id = o.partition_id
      WHERE d.active = 1
    `);
    const owners = new Map<
      string,
      { collection: string; chunk: string; embedded: boolean }
    >();
    try {
      for (const row of statement.iterate(
        JSON.stringify([...usablePartitions.keys()])
      )) {
        const partition = row.partition_id
          ? usablePartitions.get(row.partition_id)
          : undefined;
        const embedded = Boolean(
          partition &&
          row.embedding_bytes ===
            partition.dimensions * Float32Array.BYTES_PER_ELEMENT &&
          row.input_hash ===
            embeddingInputHash(
              formatDocForEmbedding(
                row.text,
                row.title ?? undefined,
                partition.model
              )
            )
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
