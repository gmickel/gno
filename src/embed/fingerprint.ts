/**
 * Embedding freshness fingerprint.
 *
 * @module src/embed/fingerprint
 */

import { getEmbeddingCompatibilityProfile } from "../llm/embedding-compatibility";

export const EMBEDDING_CONTEXTUAL_FORMAT_VERSION = "contextual-embedding-v1";
export const EMBEDDING_CHUNKING_STRATEGY_VERSION = "markdown-char-semantic-v1";

export interface EmbeddingFingerprintInput {
  modelUri: string;
  dimensions?: number;
}

export function getEmbeddingFingerprint(
  input: EmbeddingFingerprintInput
): string {
  const profile = getEmbeddingCompatibilityProfile(input.modelUri);
  const payload = {
    chunking: EMBEDDING_CHUNKING_STRATEGY_VERSION,
    contextualFormatting: EMBEDDING_CONTEXTUAL_FORMAT_VERSION,
    dimensions: input.dimensions ?? null,
    modelUri: input.modelUri,
    profile: {
      batchEmbeddingTrusted: profile.batchEmbeddingTrusted,
      documentFormat: profile.documentFormat,
      id: profile.id,
      queryFormat: profile.queryFormat,
    },
  };

  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Partition identity: actual weights plus the formatter policy. Runtime details
 * (Bun, native binding, backend, threads) are provenance, never identity; the
 * measured compatibility check decides whether a runtime may share vectors.
 */
export function getVariantModelFingerprint(
  input: EmbeddingFingerprintInput,
  identity: { modelFingerprint: string }
): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        identity.modelFingerprint,
        getEmbeddingFingerprint(input),
      ])
    )
    .digest("hex");
}
