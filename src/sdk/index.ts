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
