/**
 * LLM subsystem public API.
 *
 * @module src/llm
 */

export type { ParsedModelUri } from './cache';
// Cache
export { ModelCache, parseModelUri, toNodeLlamaCppUri } from './cache';
// Errors
export type { LlmError, LlmErrorCode } from './errors';
export {
  corruptedError,
  downloadFailedError,
  inferenceFailedError,
  invalidUriError,
  isRetryable,
  llmError,
  loadFailedError,
  modelNotCachedError,
  modelNotFoundError,
  outOfMemoryError,
  timeoutError,
} from './errors';
// Adapter
export { createLlmAdapter, LlmAdapter } from './nodeLlamaCpp/adapter';
// Lifecycle
export {
  getModelManager,
  ModelManager,
  resetModelManager,
} from './nodeLlamaCpp/lifecycle';
// Registry
export {
  getActivePreset,
  getModelConfig,
  getPreset,
  listPresets,
  resolveModelUri,
} from './registry';
// Types
export type {
  DownloadProgress,
  EmbeddingPort,
  GenerationPort,
  GenParams,
  LlmResult,
  LoadedModel,
  ModelCacheEntry,
  ModelConfig,
  ModelPreset,
  ModelStatus,
  ModelType,
  ModelUri,
  ProgressCallback,
  RerankPort,
  RerankScore,
} from './types';
