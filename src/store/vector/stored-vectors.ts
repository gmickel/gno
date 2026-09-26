/**
 * Stored document vectors for document-to-document similarity. Reads the
 * activated vector partition (legacy `content_vectors` only before any
 * partition activates) and never loads an embedding model.
 *
 * @module src/store/vector/stored-vectors
 */
import type { Database } from "bun:sqlite";

import { formatDocForEmbedding } from "../../pipeline/contextual";
import { decodeEmbedding } from "./sqlite-vec";
import { storedVectorPartition } from "./status";
import { embeddingInputHash } from "./variants";

export type StoredVectorSource =
  | {
      kind: "partition";
      model: string;
      partitionId: string;
      dimensions: number;
    }
  | { kind: "legacy"; model: string };

export function resolveStoredVectorSource(
  db: Database,
  model: string
): StoredVectorSource {
  const partition = storedVectorPartition(db, model);
  return partition
    ? { kind: "partition", model, ...partition }
    : { kind: "legacy", model };
}

/** Search options that keep a similarity search in the source's vector space. */
export function storedVectorSearchOptions(source: StoredVectorSource): {
  partitionId?: string;
} {
  return source.kind === "partition" ? { partitionId: source.partitionId } : {};
}

export interface StoredVectorDocument {
  id: number;
  mirrorHash: string;
}

interface PartitionVectorRow {
  documentId: number;
  text: string;
  title: string | null;
  inputHash: string;
  embedding: Uint8Array;
}

/**
 * Chunk vectors of current active documents, ordered by chunk seq, keyed by
 * document id. Partition vectors count only while their owner still yields
 * the stored input (the rule vector search applies). `firstChunkOnly` keeps
 * the lowest-seq vector per document.
 */
export function readStoredDocumentVectors(
  db: Database,
  source: StoredVectorSource,
  documents: StoredVectorDocument[],
  options: { firstChunkOnly?: boolean } = {}
): Map<number, Float32Array[]> {
  const vectors = new Map<number, Float32Array[]>();
  const add = (documentId: number, blob: Uint8Array): void => {
    const existing = vectors.get(documentId);
    if (existing && options.firstChunkOnly) return;
    const embedding = decodeEmbedding(blob);
    if (existing) existing.push(embedding);
    else vectors.set(documentId, [embedding]);
  };
  if (documents.length === 0) return vectors;

  if (source.kind === "partition") {
    const rows = db
      .query<PartitionVectorRow, [string, string]>(`
        SELECT o.document_id AS documentId, c.text, d.title,
          v.input_hash AS inputHash, v.embedding
        FROM vector_owners o
        JOIN documents d ON d.id = o.document_id AND d.active = 1
          AND d.mirror_hash = o.mirror_hash
        JOIN content_chunks c ON c.mirror_hash = o.mirror_hash AND c.seq = o.seq
        JOIN vector_variants v ON v.variant_id = o.variant_id
          AND v.partition_id = o.partition_id
        WHERE o.partition_id = ?
          AND o.document_id IN (SELECT value FROM json_each(?))
        ORDER BY o.document_id, o.seq
      `)
      .all(
        source.partitionId,
        JSON.stringify(documents.map((document) => document.id))
      );
    for (const row of rows) {
      if (options.firstChunkOnly && vectors.has(row.documentId)) continue;
      const input = formatDocForEmbedding(
        row.text,
        row.title ?? undefined,
        source.model
      );
      if (row.inputHash === embeddingInputHash(input))
        add(row.documentId, row.embedding);
    }
    return vectors;
  }

  const idsByMirror = new Map<string, number[]>();
  for (const document of documents) {
    const ids = idsByMirror.get(document.mirrorHash);
    if (ids) ids.push(document.id);
    else idsByMirror.set(document.mirrorHash, [document.id]);
  }
  const rows = db
    .query<{ mirrorHash: string; embedding: Uint8Array }, [string, string]>(`
      SELECT mirror_hash AS mirrorHash, embedding FROM content_vectors
      WHERE model = ? AND mirror_hash IN (SELECT value FROM json_each(?))
      ORDER BY mirror_hash, seq
    `)
    .all(source.model, JSON.stringify([...idsByMirror.keys()]));
  for (const row of rows) {
    for (const id of idsByMirror.get(row.mirrorHash) ?? [])
      add(id, row.embedding);
  }
  return vectors;
}
