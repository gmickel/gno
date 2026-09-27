/**
 * Embedded-index fixture for document similarity: writes one synthetic vector
 * per active document into an activated vector partition, as `gno embed`
 * leaves it (legacy `content_vectors` stays empty).
 */
import type { Database } from "bun:sqlite";

import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { createVectorVariantStore } from "../../src/store/vector/variants";

const BETA = "# Beta\n\nBeta notes about retries.\n";
/** Beta's content with other bytes: its own docid, beta's mirror. */
const BETA_TWIN = BETA.replaceAll("\n", "\r\n");

/**
 * alpha and beta point the same way; gamma is orthogonal to both. The twins
 * share beta's content and sit on both sides of it in insertion order, so
 * mapping hits by content hash alone picks a twin whichever duplicate it keeps.
 */
export const SIMILARITY_VECTORS: Record<string, number[]> = {
  "a-twin.md": [0.9, 0.1, 0],
  "alpha.md": [1, 0, 0],
  "beta.md": [0.9, 0.1, 0],
  "gamma.md": [0, 0, 1],
  "z-twin.md": [0.9, 0.1, 0],
};

/** File contents in insertion order (see SIMILARITY_VECTORS). */
export const SIMILARITY_DOCS: Record<string, string> = {
  "a-twin.md": BETA_TWIN,
  "alpha.md": "# Alpha\n\nAlpha notes about retries.\n",
  "beta.md": BETA,
  "gamma.md": "# Gamma\n\nGamma notes about gardening.\n",
  "z-twin.md": BETA_TWIN,
};

/** alpha's only neighbour at threshold 0.5: cos([1,0,0], [0.9,0.1,0]). */
export const ALPHA_BETA_SCORE = 0.9 / Math.hypot(0.9, 0.1);

/** Index SIMILARITY_DOCS as one-chunk documents of an open store. */
export async function seedSimilarityDocuments(
  store: SqliteAdapter,
  collection: string
): Promise<void> {
  for (const [relPath, file] of Object.entries(SIMILARITY_DOCS)) {
    // Distinct source hashes (docids derive from them); documents with the
    // same canonical content share one mirror, as ingestion stores them.
    const markdown = file.replaceAll("\r\n", "\n");
    const hash = `mirror-${Bun.hash(markdown).toString(16)}`;
    const inserted = await store.upsertDocument({
      collection,
      relPath,
      sourceHash: `${relPath}-similarity`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: file.length,
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

/**
 * Activate a partition for `model` holding `vectors` keyed by rel path, then
 * retitle the twins. A title is part of the embedded input, so the twins are
 * left as owners of beta's content without a current vector of their own,
 * as after a title edit that has not been re-embedded yet.
 */
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
  db.run(
    "UPDATE documents SET title = 'Retitled twin' WHERE rel_path IN ('a-twin.md', 'z-twin.md')"
  );
}
