/**
 * Stored document vectors for document-to-document similarity. Reads the
 * activated vector partition (legacy `content_vectors` only before any
 * partition activates) and never loads an embedding model.
 *
 * @module src/store/vector/stored-vectors
 */
import type { Database } from "bun:sqlite";

import type { VectorSearchResult } from "./types";

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

const unitVector = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm > 0 ? vector.map((value) => value / norm) : vector;
};

/**
 * The similarity source vector of each current active document, keyed by
 * document id: the stored vector of its first chunk (lowest seq whose vector
 * is current), unit-normalized. Every similarity surface (CLI, MCP, REST and
 * graph edges) uses this one rule, so scores agree. Partition vectors count
 * only while their owner still yields the stored input (the rule vector
 * search applies).
 */
export function readSimilaritySourceVectors(
  db: Database,
  source: StoredVectorSource,
  documents: StoredVectorDocument[]
): Map<number, Float32Array> {
  const vectors = new Map<number, Float32Array>();
  const add = (documentId: number, blob: Uint8Array): void => {
    if (!vectors.has(documentId))
      vectors.set(documentId, unitVector(decodeEmbedding(blob)));
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
      if (vectors.has(row.documentId)) continue;
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

/**
 * Candidate documents of similarity search hits, in hit order. Partition hits
 * name their exact owners (a title is part of the embedded input, so documents
 * sharing content can hold different vectors); only those owners count, and
 * an owner without its own vector never inherits another's score. Legacy
 * `content_vectors` hits carry no owners and map to the first document with
 * that content, as before.
 */
export function similarityHitDocuments<
  T extends { id: number; mirrorHash: string | null },
>(
  hits: VectorSearchResult[],
  documents: T[]
): Array<{ document: T; distance: number }> {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const byHash = new Map<string, T>();
  for (const document of documents) {
    if (document.mirrorHash && !byHash.has(document.mirrorHash))
      byHash.set(document.mirrorHash, document);
  }
  return hits.flatMap((hit) => {
    const owners = hit.documentIds
      ? hit.documentIds.map((id) => byId.get(id))
      : [byHash.get(hit.mirrorHash)];
    return owners.flatMap((document) =>
      document ? [{ document, distance: hit.distance }] : []
    );
  });
}
