/**
 * LLM subsystem types.
 * Port interfaces for embedding, generation, and reranking.
 *
 * @module src/llm/types
 */

import type { LlmError } from './errors';

// ─────────────────────────────────────────────────────────────────────────────
// Result Type
// ─────────────────────────────────────────────────────────────────────────────

export type LlmResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LlmError };

// ─────────────────────────────────────────────────────────────────────────────
// Model Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModelType = 'embed' | 'rerank' | 'gen';

/** Model URI format: hf:org/repo/file.gguf or file:/path */
export type ModelUri = string;

// ModelPreset is defined in config/types.ts (source of truth)
// Re-exported from index.ts for convenience

export type ModelCacheEntry = {
  uri: ModelUri;
  type: ModelType;
  path: string;
  size: number;
  checksum: string;
  cachedAt: string;
};

export type ModelStatus = {
  uri: ModelUri;
  cached: boolean;
  path: string | null;
  size?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Generation Parameters
// ─────────────────────────────────────────────────────────────────────────────

export type GenParams = {
  /** Temperature (0 = deterministic). Default: 0 */
  temperature?: number;
  /** Random seed for reproducibility. Default: 42 */
  seed?: number;
  /** Max tokens to generate. Default: 256 */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Rerank Types
// ─────────────────────────────────────────────────────────────────────────────

export type RerankScore = {
  /** Original index in input array */
  index: number;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Rank position (1 = best) */
  rank: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Port Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export type EmbeddingPort = {
  readonly modelUri: string;
  embed(text: string): Promise<LlmResult<number[]>>;
  embedBatch(texts: string[]): Promise<LlmResult<number[][]>>;
  dimensions(): number;
  dispose(): Promise<void>;
};

export type GenerationPort = {
  readonly modelUri: string;
  generate(prompt: string, params?: GenParams): Promise<LlmResult<string>>;
  dispose(): Promise<void>;
};

export type RerankPort = {
  readonly modelUri: string;
  rerank(query: string, documents: string[]): Promise<LlmResult<RerankScore[]>>;
  dispose(): Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Loaded Model (internal)
// ─────────────────────────────────────────────────────────────────────────────

export type LoadedModel = {
  uri: ModelUri;
  type: ModelType;
  model: unknown; // LlamaModel from node-llama-cpp
  loadedAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Config Types
// ─────────────────────────────────────────────────────────────────────────────

// ModelConfig is defined in config/types.ts (source of truth)
// Re-exported from index.ts for convenience

// ─────────────────────────────────────────────────────────────────────────────
// Progress Callback
// ─────────────────────────────────────────────────────────────────────────────

export type DownloadProgress = {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
};

export type ProgressCallback = (progress: DownloadProgress) => void;
