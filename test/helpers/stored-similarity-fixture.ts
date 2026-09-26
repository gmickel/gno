/**
 * Embedded-index fixture for document similarity: writes one synthetic vector
 * per active document into an activated vector partition, as `gno embed`
 * leaves it (legacy `content_vectors` stays empty).
 */
import type { Database } from "bun:sqlite";

import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { createVectorVariantStore } from "../../src/store/vector/variants";

/** alpha and beta point the same way; gamma is orthogonal to both. */
export const SIMILARITY_VECTORS: Record<string, number[]> = {
  "alpha.md": [1, 0, 0],
  "beta.md": [0.9, 0.1, 0],
  "gamma.md": [0, 0, 1],
};

export const SIMILARITY_DOCS: Record<string, string> = {
  "alpha.md": "# Alpha\n\nAlpha notes about retries.\n",
  "beta.md": "# Beta\n\nBeta notes about retries.\n",
  "gamma.md": "# Gamma\n\nGamma notes about gardening.\n",
};

/** Index SIMILARITY_DOCS as one-chunk documents of an open store. */
export async function seedSimilarityDocuments(
  store: SqliteAdapter,
  collection: string
): Promise<void> {
  for (const [relPath, markdown] of Object.entries(SIMILARITY_DOCS)) {
    // Distinct hash prefixes: docids derive from the source hash prefix.
    const hash = `${relPath}-similarity`;
    const inserted = await store.upsertDocument({
      collection,
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: markdown.length,
      sourceMtime: "2026-09-27T00:00:00Z",
      title: relPath,
      mirrorHash: hash,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    const content = await store.upsertContent(hash, markdown);
    if (!content.ok) throw new Error(content.error.message);
    const chunks = await store.upsertChunks(hash, [
      { seq: 0, pos: 0, text: markdown, startLine: 1, endLine: 3 },
    ]);
    if (!chunks.ok) throw new Error(chunks.error.message);
  }
}

/** Activate a partition for `model` holding `vectors` keyed by rel path. */
export async function embedStoredSimilarityVectors(
  db: Database,
  model: string,
  vectors: Record<string, number[]> = SIMILARITY_VECTORS
): Promise<void> {
  const dimensions = Object.values(vectors)[0]?.length ?? 0;
  const variants = await createVectorVariantStore(db, {
    model,
    modelFingerprint: "synthetic-similarity-weights",
    contextSize: 512,
    truncationPolicy: "truncate-tail-v1",
    dimensions,
  });
  const relPaths = new Map(
    db
      .query<{ id: number; rel_path: string }, []>(
        "SELECT id, rel_path FROM documents WHERE active = 1"
      )
      .all()
      .map((row) => [row.id, row.rel_path])
  );
  variants.write(
    variants.pending().map((owner) => {
      const relPath = relPaths.get(owner.documentId) ?? "";
      const vector = vectors[relPath];
      if (!vector) throw new Error(`No synthetic vector for ${relPath}`);
      return { owner, embedding: new Float32Array(vector) };
    })
  );
  variants.activate(variants.epoch());
}
