/**
 * Search pipeline public API.
 *
 * @module src/pipeline
 */

// Contextual embedding
export {
  extractTitle,
  formatDocForEmbedding,
  formatQueryForEmbedding,
} from './contextual';
// Expansion
export { expandQuery, generateCacheKey } from './expansion';
// Explain
export {
  buildExplainResults,
  type ExpansionStatus,
  explainBm25,
  explainExpansion,
  explainFusion,
  explainRerank,
  explainVector,
  formatExplain,
  formatResultExplain,
} from './explain';
// Fusion
export { type RankedInput, rrfFuse, toRankedInput } from './fusion';
// Hybrid search
export { type HybridSearchDeps, searchHybrid } from './hybrid';
// Rerank
export { rerankCandidates } from './rerank';
// BM25 search
export { searchBm25 } from './search';
// Types
export type {
  AskMeta,
  AskOptions,
  AskPort,
  AskResult,
  BlendingTier,
  Bm25SearchPort,
  Citation,
  ExpansionPort,
  ExpansionResult,
  ExplainLine,
  ExplainResult,
  FusionCandidate,
  FusionSource,
  HybridSearchOptions,
  HybridSearchPort,
  PipelineConfig,
  RerankedCandidate,
  RrfConfig,
  SearchMeta,
  SearchMode,
  SearchOptions,
  SearchResult,
  SearchResultConversion,
  SearchResultSource,
  SearchResults,
  SnippetRange,
  VectorSearchPort,
} from './types';
export {
  DEFAULT_BLENDING_SCHEDULE,
  DEFAULT_PIPELINE_CONFIG,
  DEFAULT_RRF_CONFIG,
} from './types';
// Vector search
export { searchVector, type VectorSearchDeps } from './vsearch';
