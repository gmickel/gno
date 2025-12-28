/**
 * Search pipeline types.
 * Defines SearchPipelinePort and related types for search operations.
 *
 * @module src/pipeline/types
 */

import type { StoreResult } from '../store/types';

// ─────────────────────────────────────────────────────────────────────────────
// Search Result Types
// ─────────────────────────────────────────────────────────────────────────────

/** Source metadata for a search result */
export type SearchResultSource = {
  relPath: string;
  absPath?: string;
  mime: string;
  ext: string;
  modifiedAt?: string;
  sizeBytes?: number;
  sourceHash?: string;
};

/** Conversion metadata for a search result */
export type SearchResultConversion = {
  converterId?: string;
  converterVersion?: string;
  mirrorHash: string;
  warnings?: { code: string; message: string }[];
};

/** Snippet range in mirror content */
export type SnippetRange = {
  startLine: number;
  endLine: number;
};

/** Single search result matching output schema */
export type SearchResult = {
  docid: string;
  score: number;
  uri: string;
  title?: string;
  snippet: string;
  snippetLanguage?: string;
  snippetRange?: SnippetRange;
  context?: string;
  source: SearchResultSource;
  conversion?: SearchResultConversion;
};

/** Search mode enum */
export type SearchMode = 'bm25' | 'vector' | 'hybrid' | 'bm25_only';

/** Search metadata */
export type SearchMeta = {
  query: string;
  mode: SearchMode;
  expanded?: boolean;
  reranked?: boolean;
  vectorsUsed?: boolean;
  totalResults: number;
  collection?: string;
  lang?: string;
  /** Detected/overridden query language for prompt selection (typically BCP-47; may be user-provided via --lang) */
  queryLanguage?: string;
  /** Explain data (when --explain is used) */
  explain?: {
    lines: ExplainLine[];
    results: ExplainResult[];
  };
};

/** Complete search results wrapper */
export type SearchResults = {
  results: SearchResult[];
  meta: SearchMeta;
};

// ─────────────────────────────────────────────────────────────────────────────
// Search Options
// ─────────────────────────────────────────────────────────────────────────────

/** Common options for all search commands */
export type SearchOptions = {
  /** Max results */
  limit?: number;
  /** Min score threshold (0-1) */
  minScore?: number;
  /** Filter by collection */
  collection?: string;
  /** Language filter/hint (BCP-47) */
  lang?: string;
  /** Include full content instead of snippet */
  full?: boolean;
  /** Include line numbers */
  lineNumbers?: boolean;
};

/** Options for hybrid search (gno query) */
export type HybridSearchOptions = SearchOptions & {
  /** Disable query expansion */
  noExpand?: boolean;
  /** Disable reranking */
  noRerank?: boolean;
  /** Enable explain output */
  explain?: boolean;
};

/** Options for ask command */
export type AskOptions = HybridSearchOptions & {
  /** Generate grounded answer */
  answer?: boolean;
  /** Force retrieval-only output */
  noAnswer?: boolean;
  /** Max tokens for answer */
  maxAnswerTokens?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Query Expansion Types
// ─────────────────────────────────────────────────────────────────────────────

/** Expansion result from LLM */
export type ExpansionResult = {
  lexicalQueries: string[];
  vectorQueries: string[];
  hyde?: string;
  notes?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Fusion Types
// ─────────────────────────────────────────────────────────────────────────────

/** RRF config */
export type RrfConfig = {
  /** RRF constant (default: 60) */
  k: number;
  /** Weight for BM25 source */
  bm25Weight: number;
  /** Weight for vector source */
  vecWeight: number;
  /** Bonus for top-rank in both modes */
  topRankBonus: number;
  /** Max rank for top-rank bonus */
  topRankThreshold: number;
};

/** Default RRF configuration */
export const DEFAULT_RRF_CONFIG: RrfConfig = {
  k: 60,
  bm25Weight: 1.0,
  vecWeight: 1.0,
  topRankBonus: 0.1,
  topRankThreshold: 5,
};

/** Chunk identifier for fusion tracking */
export type ChunkId = {
  mirrorHash: string;
  seq: number;
};

/** Source for a fusion candidate */
export type FusionSource =
  | 'bm25'
  | 'vector'
  | 'bm25_variant'
  | 'vector_variant'
  | 'hyde';

/** Fusion candidate with ranks from different sources */
export type FusionCandidate = {
  mirrorHash: string;
  seq: number;
  bm25Rank: number | null;
  vecRank: number | null;
  fusionScore: number;
  sources: FusionSource[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Rerank & Blending Types
// ─────────────────────────────────────────────────────────────────────────────

/** Blending tier config */
export type BlendingTier = {
  maxRank: number;
  fusionWeight: number;
  rerankWeight: number;
};

/** Default blending schedule */
export const DEFAULT_BLENDING_SCHEDULE: BlendingTier[] = [
  { maxRank: 3, fusionWeight: 0.75, rerankWeight: 0.25 },
  { maxRank: 10, fusionWeight: 0.6, rerankWeight: 0.4 },
  { maxRank: Number.POSITIVE_INFINITY, fusionWeight: 0.4, rerankWeight: 0.6 },
];

/** Result after reranking */
export type RerankedCandidate = FusionCandidate & {
  rerankScore: number | null;
  blendedScore: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Config
// ─────────────────────────────────────────────────────────────────────────────

/** Search pipeline configuration */
export type PipelineConfig = {
  /** Strong BM25 threshold to skip expansion */
  strongBm25Threshold: number;
  /** Expansion timeout in ms */
  expansionTimeout: number;
  /** Max candidates to rerank */
  rerankCandidates: number;
  /** RRF configuration */
  rrf: RrfConfig;
  /** Blending schedule */
  blendingSchedule: BlendingTier[];
};

/** Default pipeline configuration */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  strongBm25Threshold: 0.7,
  expansionTimeout: 5000,
  rerankCandidates: 20,
  rrf: DEFAULT_RRF_CONFIG,
  blendingSchedule: DEFAULT_BLENDING_SCHEDULE,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ask Types
// ─────────────────────────────────────────────────────────────────────────────

/** Citation reference */
export type Citation = {
  docid: string;
  uri: string;
  startLine?: number;
  endLine?: number;
};

/** Ask result metadata */
export type AskMeta = {
  expanded: boolean;
  reranked: boolean;
  vectorsUsed: boolean;
  answerGenerated?: boolean;
  totalResults?: number;
};

/** Ask command result */
export type AskResult = {
  query: string;
  mode: 'hybrid' | 'bm25_only';
  queryLanguage: string;
  answer?: string;
  citations?: Citation[];
  results: SearchResult[];
  meta: AskMeta;
};

// ─────────────────────────────────────────────────────────────────────────────
// Port Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** BM25 search port */
export type Bm25SearchPort = {
  search(
    query: string,
    options?: SearchOptions
  ): Promise<StoreResult<SearchResults>>;
};

/** Vector search port */
export type VectorSearchPort = {
  search(
    query: string,
    options?: SearchOptions
  ): Promise<StoreResult<SearchResults>>;
};

/** Query expansion port */
export type ExpansionPort = {
  expand(
    query: string,
    lang?: string
  ): Promise<StoreResult<ExpansionResult | null>>;
};

/** Hybrid search port */
export type HybridSearchPort = {
  search(
    query: string,
    options?: HybridSearchOptions
  ): Promise<StoreResult<SearchResults>>;
};

/** Ask port */
export type AskPort = {
  ask(query: string, options?: AskOptions): Promise<StoreResult<AskResult>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Explain Types
// ─────────────────────────────────────────────────────────────────────────────

/** Explain output line */
export type ExplainLine = {
  stage: string;
  message: string;
};

/** Detailed explain for a result */
export type ExplainResult = {
  rank: number;
  docid: string;
  score: number;
  bm25Score?: number;
  vecScore?: number;
  rerankScore?: number;
};
