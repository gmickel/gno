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
  // Activated metadata supplies dimensions only, never query eligibility.
  // The vector search still validates the actual inference identity and epoch.
  const hasVariants = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_partitions'"
    )
    .get();
  if (hasVariants) {
    const partitions = db
      .prepare(`SELECT dimensions FROM vector_partitions
      WHERE model = ? AND state = 'active' AND activated_epoch IS NOT NULL`)
      .all(model) as { dimensions: number }[];
    if (partitions.length) {
      const dimensions = partitions[0]?.dimensions;
      return dimensions !== undefined &&
        Number.isSafeInteger(dimensions) &&
        dimensions > 0 &&
        partitions.every((partition) => partition.dimensions === dimensions)
        ? dimensions
        : undefined;
    }
  }
  // Validate the entire model partition: never trust an arbitrary first blob.
  const row = db
    .prepare(`SELECT MIN(length(embedding)) AS smallest,
    MAX(length(embedding)) AS largest FROM content_vectors WHERE model = ?`)
    .get(model) as { smallest: number | null; largest: number | null };
  const bytes = row.smallest;
  if (
    !bytes ||
    bytes !== row.largest ||
    bytes % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    return undefined;
  }
  return bytes / Float32Array.BYTES_PER_ELEMENT;
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
