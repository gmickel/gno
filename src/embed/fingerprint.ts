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
