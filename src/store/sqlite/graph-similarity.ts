/**
 * Graph similarity edges scored from stored document vectors.
 *
 * @module src/store/sqlite/graph-similarity
 */
import type { Database } from "bun:sqlite";

import {
  readSimilaritySourceVectors,
  resolveStoredVectorSource,
} from "../vector/stored-vectors";

/** True when sqlite-vec is loaded on this connection. */
export function hasSqliteVec(db: Database): boolean {
  try {
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export interface StoredSimilarityEdge {
  source: string;
  target: string;
  /** Cosine similarity clamped to [0, 1] */
  score: number;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function compareSimilarityEdge(
  a: StoredSimilarityEdge,
  b: StoredSimilarityEdge
): number {
  return b.score - a.score || a.target.localeCompare(b.target);
}

function insertTopK(
  buffer: StoredSimilarityEdge[],
  candidate: StoredSimilarityEdge,
  topK: number
): void {
  if (
    buffer.length >= topK &&
    compareSimilarityEdge(candidate, buffer[topK - 1]!) >= 0
  ) {
    return;
  }
  let pos = buffer.length;
  while (pos > 0 && compareSimilarityEdge(candidate, buffer[pos - 1]!) < 0) {
    pos -= 1;
  }
  buffer.splice(pos, 0, candidate);
  if (buffer.length > topK) {
    buffer.pop();
  }
}

/**
 * Top-K most similar other nodes per node, by the first-chunk vector each
 * document stores for `model`. Documents sharing content are not similarity
 * edges. Null when the stored vectors cannot be read.
 */
export function storedSimilarityEdges(
  db: Database,
  model: string,
  docids: string[],
  threshold: number,
  topK: number
): { embeddedNodes: number; edges: StoredSimilarityEdge[] } | null {
  try {
    const documents = db
      .query<{ id: number; docid: string; mirrorHash: string }, [string]>(`
        SELECT id, docid, mirror_hash AS mirrorHash FROM documents
        WHERE active = 1 AND mirror_hash IS NOT NULL
          AND docid IN (SELECT value FROM json_each(?))
        ORDER BY docid
      `)
      .all(JSON.stringify(docids));
    const vectors = readSimilaritySourceVectors(
      db,
      resolveStoredVectorSource(db, model),
      documents
    );
    const nodes = documents.flatMap((document) => {
      const vector = vectors.get(document.id);
      return vector ? [{ ...document, vector }] : [];
    });
    if (topK <= 0 || nodes.length < 2) {
      return { embeddedNodes: nodes.length, edges: [] };
    }
    const buffers: StoredSimilarityEdge[][] = Array.from(
      { length: nodes.length },
      () => []
    );
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const nodeBuf = buffers[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const other = nodes[j]!;
        if (
          other.mirrorHash === node.mirrorHash ||
          other.vector.length !== node.vector.length
        ) {
          continue;
        }
        const score = Math.max(0, Math.min(1, dot(node.vector, other.vector)));
        if (score >= threshold) {
          insertTopK(
            nodeBuf,
            { source: node.docid, target: other.docid, score },
            topK
          );
          insertTopK(
            buffers[j]!,
            { source: other.docid, target: node.docid, score },
            topK
          );
        }
      }
    }
    const edges: StoredSimilarityEdge[] = [];
    for (const buf of buffers) {
      edges.push(...buf);
    }
    return { embeddedNodes: nodes.length, edges };
  } catch {
    return null;
  }
}
