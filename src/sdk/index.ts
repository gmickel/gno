/**
 * Public SDK entrypoint.
 *
 * @module src/sdk
 */

export { createDefaultConfig, ConfigSchema } from "../config";
export type {
  Collection,
  Config,
  Context,
  ModelConfig,
  ModelPreset,
} from "../config/types";
export type { DownloadPolicy } from "../llm/policy";
export type {
  AskOptions,
  AskResult,
  QueryMode,
  QueryModeInput,
  QueryModeSummary,
  SearchOptions,
  SearchResult,
  SearchResults,
} from "../pipeline/types";
export type { IndexStatus } from "../store/types";

export { GnoSdkError, sdkError } from "./errors";
export { createGnoClient } from "./client";
export type {
  GnoAskOptions,
  GnoCaptureOptions,
  GnoCaptureResult,
  GnoContextErrorCode,
  GnoContextInput,
  GnoContextResult,
  GnoContextVerificationResult,
  GnoClient,
  GnoClientInitOptions,
  GnoEmbedOptions,
  GnoEmbedResult,
  GnoGetOptions,
  GnoGetResult,
  GnoIndexOptions,
  GnoIndexResult,
  GnoListDocument,
  GnoListOptions,
  GnoListResult,
  GnoModelOverrides,
  GnoMultiGetDocument,
  GnoMultiGetOptions,
  GnoMultiGetResult,
  GnoQueryOptions,
  GnoSkippedDocument,
  GnoUpdateOptions,
  GnoVectorSearchOptions,
} from "./types";
export {
  ContextCapsuleContractError,
  type ContextCapsuleErrorCode,
  type ContextCapsuleV1,
} from "../core/context-capsule";
export {
  ContextEvidenceError,
  type ContextEvidenceErrorCode,
} from "../core/context-evidence";
export {
  ContextVerifierError,
  type ContextVerifierErrorCode,
} from "../core/context-verifier";
export {
  ContextRuntimeError,
  type ContextRuntimeErrorCode,
} from "../app/context-runtime";
export {
  getRetrievalTraceMetadata,
  RETRIEVAL_TRACE_METADATA,
  type RetrievalTraceSurfaceMetadata,
} from "../core/retrieval-trace-session";
export type {
  RetrievalTraceDeleteResult,
  RetrievalTraceDetail,
  RetrievalTraceExportRequest,
  RetrievalTraceExportResult,
  RetrievalTraceLabelRequest,
  RetrievalTraceLabelResult,
  RetrievalTraceListRequest,
  RetrievalTraceListResult,
  RetrievalTracePurgeResult,
  RetrievalTraceSummary,
} from "../core/retrieval-trace-management";
