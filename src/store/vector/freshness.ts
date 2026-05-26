/**
 * Vector freshness helpers.
 *
 * @module src/store/vector/freshness
 */

import type { Database } from "bun:sqlite";

import { getEmbeddingFingerprint } from "../../embed/fingerprint";

export function getStoredEmbeddingDimensions(
  db: Database,
  model: string
): number | undefined {
  const row = db
    .prepare("SELECT embedding FROM content_vectors WHERE model = ? LIMIT 1")
    .get(model) as { embedding: Uint8Array } | undefined;

  if (!row?.embedding) {
    return undefined;
  }

  return row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT;
}

export function getStoredEmbeddingFingerprint(
  db: Database,
  modelUri: string
): string {
  return getEmbeddingFingerprint({
    modelUri,
    dimensions: getStoredEmbeddingDimensions(db, modelUri),
  });
}
