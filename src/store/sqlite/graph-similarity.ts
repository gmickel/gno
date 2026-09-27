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
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
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
    const edges: StoredSimilarityEdge[] = [];
    for (const node of nodes) {
      const scored: StoredSimilarityEdge[] = [];
      for (const other of nodes) {
        if (
          other.mirrorHash === node.mirrorHash ||
          other.vector.length !== node.vector.length
        )
          continue;
        const score = Math.max(0, Math.min(1, dot(node.vector, other.vector)));
        if (score >= threshold)
          scored.push({ source: node.docid, target: other.docid, score });
      }
      scored.sort(
        (a, b) => b.score - a.score || a.target.localeCompare(b.target)
      );
      edges.push(...scored.slice(0, topK));
    }
    return { embeddedNodes: nodes.length, edges };
  } catch {
    return null;
  }
}
