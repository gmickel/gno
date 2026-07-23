/**
 * Search pipeline types.
 * Defines SearchPipelinePort and related types for search operations.
 *
 * @module src/pipeline/types
 */

import type {
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";
import type { RetrievalTraceSession } from "../core/retrieval-trace-session";
import type { StoreResult } from "../store/types";
import type { ClaimVerificationResult } from "./claim-verification";
import type { SemanticVerificationCapability } from "./claim-verifier";

// ─────────────────────────────────────────────────────────────────────────────
// Search Result Types
// ─────────────────────────────────────────────────────────────────────────────

/** Source metadata for a search result */
export interface SearchResultSource {
  relPath: string;
  absPath?: string;
  mime: string;
  ext: string;
  modifiedAt?: string;
  documentDate?: string;
  sizeBytes?: number;
  sourceHash?: string;
}

/** Conversion metadata for a search result */
export interface SearchResultConversion {
  converterId?: string;
  converterVersion?: string;
  mirrorHash: string;
  warnings?: { code: string; message: string }[];
}

/** Snippet range in mirror content */
export interface SnippetRange {
  startLine: number;
  endLine: number;
}

/** Symbol-keyed planner metadata; omitted from JSON/API projections. */
export const SEARCH_RESULT_PLANNER_METADATA = Symbol(
  "gno.searchResultPlannerMetadata"
);

export interface SearchResultPlannerMetadata {
  retrievalRank: number;
  mirrorHash: string;
  seq: number;
  sources: FusionSource[];
  graphExpanded: boolean;
  /** Exact canonical chunk coordinates, retained even for full-content output. */
  startLine?: number;
  endLine?: number;
  /** SHA-256 of the complete canonical chunk lines. */
  passageHash?: string;
}

/** Single search result matching output schema */
export interface SearchResult {
  docid: string;
  score: number;
  uri: string;
  title?: string;
  contentType?: string;
  categories?: string[];
  /** Best source line for editor/agent anchors (1-indexed) */
  line?: number;
  snippet: string;
  snippetLanguage?: string;
  snippetRange?: SnippetRange;
  context?: string;
  source: SearchResultSource;
  conversion?: SearchResultConversion;
  [SEARCH_RESULT_PLANNER_METADATA]?: SearchResultPlannerMetadata;
}

/** Search mode enum */
export type SearchMode = "bm25" | "vector" | "hybrid" | "bm25_only";

/** Search metadata */
export interface SearchMeta {
  query: string;
  mode: SearchMode;
  expanded?: boolean;
  reranked?: boolean;
  vectorsUsed?: boolean;
  totalResults: number;
  intent?: string;
  collection?: string;
  lang?: string;
  /** Detected/overridden query language for prompt selection (typically BCP-47; may be user-provided via --lang) */
  queryLanguage?: string;
  /** Summary of structured query modes applied (if provided) */
  queryModes?: QueryModeSummary;
  /** Temporal filter lower bound (ISO 8601) */
  since?: string;
  /** Temporal filter upper bound (ISO 8601) */
  until?: string;
  /** Category filters applied */
  categories?: string[];
  /** Author filter applied */
  author?: string;
  /** Rerank candidate limit used */
  candidateLimit?: number;
  /** Bounded graph expansion summary, when hybrid query evaluates graph neighbors */
  graphExpansion?: {
    enabled: boolean;
    seedCount: number;
    candidateCount: number;
    maxCandidates: number;
    edgeConfidence: {
      explicit: number;
      inferred: number;
      ambiguous: number;
      similarity: number;
    };
    fallbackReasons: string[];
  };
  /** Explicit exclusion terms applied */
  exclude?: string[];
  /** Explain data (when --explain is used) */
  explain?: {
    lines: ExplainLine[];
    results: ExplainResult[];
  };
  /** Internal diagnose trace, only populated when diagnoseTrace is enabled */
  trace?: QueryDiagnoseTrace;
}

export const SEARCH_RESULTS_TRACE_METADATA = Symbol(
  "gno.searchResultsTraceMetadata"
);

export interface SearchCapabilityOutcome {
  capability: string;
  status: "attempted" | "used" | "unavailable" | "failed";
  reasonCode?: string;
}

export interface SearchResultsTraceMetadata {
  capabilityOutcomes: SearchCapabilityOutcome[];
  fallbackCodes: string[];
}

/** Complete search results wrapper */
export interface SearchResults {
  results: SearchResult[];
  meta: SearchMeta;
  [SEARCH_RESULTS_TRACE_METADATA]?: SearchResultsTraceMetadata;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Options
// ─────────────────────────────────────────────────────────────────────────────

/** Common options for all search commands */
export interface SearchOptions {
  /** Internal receipt seam; never serialized or included in public schemas. */
  traceSession?: RetrievalTraceSession;
  /** Max results */
  limit?: number;
  /** Min score threshold (0-1) */
  minScore?: number;
  /** Filter by collection */
  collection?: string;
  /** Internal exact corpus scope used by deterministic retrieval replay. */
  retrievalScope?: {
    relPathPrefix?: string;
    allowedMirrorHashes: string[];
  };
  /** Language filter/hint (BCP-47) */
  lang?: string;
  /** Include full content instead of snippet */
  full?: boolean;
  /** Include line numbers */
  lineNumbers?: boolean;
  /** Filter to docs with ALL of these tags (AND) */
  tagsAll?: string[];
  /** Filter to docs with ANY of these tags (OR) */
  tagsAny?: string[];
  /** Filter by modified time lower bound (ISO 8601 or relative token) */
  since?: string;
  /** Filter by modified time upper bound (ISO 8601 or relative token) */
  until?: string;
  /** Filter to docs matching ANY category */
  categories?: string[];
  /** Filter by author value */
  author?: string;
  /** Optional disambiguating context that steers scoring/snippets, but is not searched directly */
  intent?: string;
  /** Explicit exclusion terms for hard candidate pruning */
  exclude?: string[];
}

/** Structured query mode identifier */
export type QueryMode = "term" | "intent" | "hyde";

/** Structured query mode entry */
export interface QueryModeInput {
  mode: QueryMode;
  text: string;
}

/** Structured query mode summary for metadata/explain */
export interface QueryModeSummary {
  term: number;
  intent: number;
  hyde: boolean;
}

/** Options for hybrid search (gno query) */
export type HybridSearchOptions = SearchOptions & {
  /** Disable query expansion */
  noExpand?: boolean;
  /** Disable reranking */
  noRerank?: boolean;
  /** Optional structured mode entries; when set, used as expansion inputs */
  queryModes?: QueryModeInput[];
  /** Max candidates passed to reranking */
  candidateLimit?: number;
  /** Enable explain output */
  explain?: boolean;
  /** Enable bounded one-hop graph candidate expansion */
  graph?: boolean;
  /** Compatibility no-op unless graph is also true */
  noGraph?: boolean;
  /** Language hint for prompt selection (does NOT filter retrieval, only affects expansion prompts) */
  queryLanguageHint?: string;
  /** Internal: capture per-stage candidates for query diagnose */
  diagnoseTrace?: boolean;
};

/** Options for ask command */
export type AskOptions = HybridSearchOptions & {
  /** Generate grounded answer */
  answer?: boolean;
  /** Force retrieval-only output */
  noAnswer?: boolean;
  /** Max tokens for answer */
  maxAnswerTokens?: number;
  /** Verify generated claims against a closed Context Capsule. */
  verify?: boolean;
  /** Global Context Capsule budget used by verified Ask. */
  contextBudgetTokens?: number;
  /** Optional explicit byte budget used by verified Ask. */
  contextBudgetBytes?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Query Expansion Types
// ─────────────────────────────────────────────────────────────────────────────

/** Expansion result from LLM */
export interface ExpansionResult {
  lexicalQueries: string[];
  vectorQueries: string[];
  hyde?: string;
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fusion Types
// ─────────────────────────────────────────────────────────────────────────────

/** RRF config */
export interface RrfConfig {
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
}

/** Default RRF configuration */
export const DEFAULT_RRF_CONFIG: RrfConfig = {
  k: 60,
  bm25Weight: 1.0,
  vecWeight: 1.0,
  topRankBonus: 0.1,
  topRankThreshold: 5,
};

/** Chunk identifier for fusion tracking */
export interface ChunkId {
  mirrorHash: string;
  seq: number;
}

/** Source for a fusion candidate */
export type FusionSource =
  | "bm25"
  | "vector"
  | "bm25_variant"
  | "vector_variant"
  | "hyde"
  | "graph";

/** Fusion candidate with ranks from different sources */
export interface FusionCandidate {
  mirrorHash: string;
  seq: number;
  bm25Rank: number | null;
  vecRank: number | null;
  fusionScore: number;
  sources: FusionSource[];
}

export type QueryDiagnoseStageId =
  | "bm25"
  | "vector"
  | "fusion"
  | "graph"
  | "rerank";

export type QueryDiagnoseStageStatus = "active" | "skipped";

export interface QueryDiagnoseTraceCandidate {
  mirrorHash: string;
  seq: number;
  rank: number;
  score: number;
}

export interface QueryDiagnoseTraceStage {
  id: QueryDiagnoseStageId;
  status: QueryDiagnoseStageStatus;
  reason?: string;
  sourceCount: number;
  candidates: QueryDiagnoseTraceCandidate[];
}

export interface QueryDiagnoseTrace {
  stages: QueryDiagnoseTraceStage[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rerank & Blending Types
// ─────────────────────────────────────────────────────────────────────────────

/** Blending tier config */
export interface BlendingTier {
  maxRank: number;
  fusionWeight: number;
  rerankWeight: number;
}

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
export interface PipelineConfig {
  /** Expansion timeout in ms */
  expansionTimeout: number;
  /** Max candidates to rerank */
  rerankCandidates: number;
  /** RRF configuration */
  rrf: RrfConfig;
  /** Blending schedule */
  blendingSchedule: BlendingTier[];
}

/** Default pipeline configuration */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  expansionTimeout: 5000,
  rerankCandidates: 20,
  rrf: DEFAULT_RRF_CONFIG,
  blendingSchedule: DEFAULT_BLENDING_SCHEDULE,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ask Types
// ─────────────────────────────────────────────────────────────────────────────

/** Citation reference */
export const CITATION_TRACE_METADATA = Symbol("gno.citationTraceMetadata");

export interface CitationTraceMetadata {
  sourceHash: string;
  mirrorHash: string;
  passageHash: string;
  seq?: number;
  rank: number;
  plannerRank?: number;
  sources?: FusionSource[];
  graphExpanded?: boolean;
}

export interface Citation {
  evidenceId?: string;
  docid: string;
  uri: string;
  startLine?: number;
  endLine?: number;
  [CITATION_TRACE_METADATA]?: CitationTraceMetadata;
}

/** Source selection entry for answer-generation explain */
export interface AnswerContextEntry {
  docid: string;
  uri: string;
  score: number;
  queryTokenHits: number;
  facetHits: number;
  reason: string;
}

/** Answer-generation context selection explain payload */
export interface AnswerContextExplain {
  strategy: "adaptive_coverage_v1";
  targetSources: number;
  facets: string[];
  selected: AnswerContextEntry[];
  dropped: AnswerContextEntry[];
}

/** Ask result metadata */
export interface AskMeta {
  expanded: boolean;
  reranked: boolean;
  vectorsUsed: boolean;
  intent?: string;
  candidateLimit?: number;
  exclude?: string[];
  queryModes?: QueryModeSummary;
  answerGenerated?: boolean;
  totalResults?: number;
  answerContext?: AnswerContextExplain;
  verificationRequested?: boolean;
  abstained?: boolean;
}

export interface AskVerification {
  schemaVersion: "1.0";
  mode: "closed_capsule";
  capsule: ContextCapsuleV1;
  freshness: ContextCapsuleVerification;
  claims: ClaimVerificationResult;
  semantic: SemanticVerificationCapability;
}

/** Ask command result */
export interface AskResult {
  query: string;
  mode: "hybrid" | "bm25_only";
  queryLanguage: string;
  answer?: string;
  citations?: Citation[];
  results: SearchResult[];
  meta: AskMeta;
  verification?: AskVerification;
}

// ─────────────────────────────────────────────────────────────────────────────
// Port Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** BM25 search port */
export interface Bm25SearchPort {
  search(
    query: string,
    options?: SearchOptions
  ): Promise<StoreResult<SearchResults>>;
}

/** Vector search port */
export interface VectorSearchPort {
  search(
    query: string,
    options?: SearchOptions
  ): Promise<StoreResult<SearchResults>>;
}

/** Query expansion port */
export interface ExpansionPort {
  expand(
    query: string,
    lang?: string
  ): Promise<StoreResult<ExpansionResult | null>>;
}

/** Hybrid search port */
export interface HybridSearchPort {
  search(
    query: string,
    options?: HybridSearchOptions
  ): Promise<StoreResult<SearchResults>>;
}

/** Ask port */
export interface AskPort {
  ask(query: string, options?: AskOptions): Promise<StoreResult<AskResult>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Explain Types
// ─────────────────────────────────────────────────────────────────────────────

/** Explain output line */
export interface ExplainLine {
  stage: string;
  message: string;
}

/** Detailed explain for a result */
export interface ExplainResult {
  rank: number;
  docid: string;
  score: number;
  fusionScore?: number;
  bm25Score?: number;
  vecScore?: number;
  rerankScore?: number;
}
