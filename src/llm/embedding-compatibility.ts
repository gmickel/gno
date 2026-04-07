/**
 * Embedding compatibility profiles.
 *
 * Encodes model-specific formatting/runtime hints for embedding models without
 * forcing every caller to special-case URIs inline.
 *
 * @module src/llm/embedding-compatibility
 */

export type EmbeddingQueryFormat = "contextual-task" | "qwen-instruct";
export type EmbeddingDocumentFormat = "title-prefixed" | "raw-text";

export interface EmbeddingCompatibilityProfile {
  id: string;
  queryFormat: EmbeddingQueryFormat;
  documentFormat: EmbeddingDocumentFormat;
  /**
   * Whether embedBatch is trusted for this model in GNO's current native path.
   * If false, callers should use per-item embedding until compatibility is
   * better understood.
   */
  batchEmbeddingTrusted: boolean;
  notes?: string[];
}

const DEFAULT_PROFILE: EmbeddingCompatibilityProfile = {
  id: "default",
  queryFormat: "contextual-task",
  documentFormat: "title-prefixed",
  batchEmbeddingTrusted: true,
};

const QWEN_PROFILE: EmbeddingCompatibilityProfile = {
  id: "qwen-embedding",
  queryFormat: "qwen-instruct",
  documentFormat: "raw-text",
  batchEmbeddingTrusted: true,
  notes: [
    "Uses Qwen-style instruct query formatting.",
    "Documents are embedded as raw text (optionally prefixed with title).",
  ],
};

const JINA_PROFILE: EmbeddingCompatibilityProfile = {
  id: "jina-embedding",
  queryFormat: "contextual-task",
  documentFormat: "title-prefixed",
  batchEmbeddingTrusted: false,
  notes: [
    "Current native runtime path has batch-embedding issues on real fixtures.",
    "Prefer per-item embedding fallback until compatibility improves.",
  ],
};

function normalizeModelUri(modelUri?: string): string {
  return modelUri?.toLowerCase() ?? "";
}

function hasAllTerms(haystack: string, terms: string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

export function getEmbeddingCompatibilityProfile(
  modelUri?: string
): EmbeddingCompatibilityProfile {
  const normalizedUri = normalizeModelUri(modelUri);

  if (hasAllTerms(normalizedUri, ["qwen", "embed"])) {
    return QWEN_PROFILE;
  }

  if (
    normalizedUri.includes("jina-embeddings-v4-text-code") ||
    normalizedUri.includes("jina-code-embeddings") ||
    hasAllTerms(normalizedUri, ["jina", "embeddings-v4-text-code"]) ||
    hasAllTerms(normalizedUri, ["jina", "code-embeddings"])
  ) {
    return JINA_PROFILE;
  }

  return DEFAULT_PROFILE;
}
