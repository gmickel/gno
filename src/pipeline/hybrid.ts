/**
 * Hybrid search orchestrator.
 * Combines BM25, vector search, expansion, fusion, and reranking.
 *
 * @module src/pipeline/hybrid
 */

import type { Config } from "../config/types";
import type { EmbeddingPort, GenerationPort, RerankPort } from "../llm/types";
import type { DocumentRow, StorePort } from "../store/types";
import type {
  VectorIndexPort,
  VectorRouteInfo,
  VectorSearchOptions,
} from "../store/vector/types";
import type {
  ExpansionResult,
  ExplainLine,
  HybridSearchOptions,
  PipelineConfig,
  QueryDiagnoseTrace,
  QueryDiagnoseTraceCandidate,
  SearchResult,
  SearchResults,
} from "./types";

import { normalizeContentTypes } from "../config/content-types";
import { projectRecordEvidenceMetadata } from "../core/record-metadata";
import { normalizeMetadataPredicate } from "../core/typed-metadata";
import { embedTextsWithRecovery } from "../embed/batch";
import {
  assertInferenceActive,
  assertInferenceResult,
  withInferenceScope,
} from "../llm/inference-scope";
import { err, ok } from "../store/types";
import {
  lexicalFallbackNotice,
  resolveVectorSearchIdentity,
  VECTOR_RUNTIME_INCOMPATIBLE,
} from "../store/vector/variant-search";
import { createChunkLookup } from "./chunk-lookup";
import {
  attachAuxiliaryScoreMetadata,
  hasAuxiliaryRanking,
  scoreContentTypeBoost,
  sortByFinalScoreStable,
} from "./content-type-boost";
import { formatQueryForEmbedding } from "./contextual";
import { attachSearchResultEgressLineage } from "./egress-lineage";
import { matchesExcludedChunks, matchesExcludedText } from "./exclude";
import { expandQuery, expandQueryCached } from "./expansion";
import {
  buildExplainResults,
  type ExpansionStatus,
  explainBm25,
  explainCounters,
  explainExpansion,
  explainFusion,
  explainQueryModes,
  explainRerank,
  explainTimings,
  explainVector,
} from "./explain";
import {
  compileDocumentFilters,
  typedMetadataFilterReason,
  typedMetadataWarnings,
} from "./filters";
import { type RankedInput, rrfFuse, toRankedInput } from "./fusion";
import { expandGraphCandidates } from "./graph-retrieval";
import { RequestHydration } from "./hydration";
import { extractSteeringTerms, selectBestChunkForSteering } from "./intent";
import { OwnerMetadataError, resolveFusionOwners } from "./owner-fusion";
import { hasProjectAffinity } from "./project-affinity";
import { detectQueryLanguage } from "./query-language";
import {
  buildExpansionFromQueryModes,
  summarizeQueryModes,
} from "./query-modes";
import { rerankCandidates } from "./rerank";
import {
  attachSearchResultContexts,
  attachSupersession,
} from "./result-context";
import { cleanDisplaySnippet } from "./snippet";
import {
  compileTemporalRange,
  isWithinTemporalRange,
  resolveRecencyTimestamp,
  resolveTemporalRange,
  shouldSortByRecency,
} from "./temporal";
import {
  attachSearchResultPlannerMetadata,
  attachSearchResultsTraceMetadata,
} from "./trace-metadata";
import {
  DEFAULT_PIPELINE_CONFIG,
  SEARCH_RESULT_PLANNER_METADATA,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface HybridSearchDeps {
  store: StorePort;
  config: Config;
  vectorIndex: VectorIndexPort | null;
  embedPort: EmbeddingPort | null;
  expandPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  pipelineConfig?: PipelineConfig;
  /** Internal request owner; the creating caller releases it. */
  hydration?: RequestHydration;
}

// ─────────────────────────────────────────────────────────────────────────────
// Score Normalization
// ─────────────────────────────────────────────────────────────────────────────

// Removed: _normalizeVectorScore was dead code (vector distances normalized in vector index)

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Score Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize raw BM25 score to 0-1 range using sigmoid.
 * BM25 scores are negative in SQLite FTS5 (more negative = better match).
 * Typical range: -15 (excellent) to -2 (weak match).
 * Maps to 0-1 where higher is better.
 */
function normalizeBm25Score(rawScore: number): number {
  const absScore = Math.abs(rawScore);
  // Sigmoid with center=4.5, scale=2.8
  // Maps: -15 → ~0.99, -5 → ~0.55, -2 → ~0.29
  return 1 / (1 + Math.exp(-(absScore - 4.5) / 2.8));
}

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Strength Check
// ─────────────────────────────────────────────────────────────────────────────

// Thresholds for strong signal detection (conservative - prefer expansion over speed)
const STRONG_TOP_SCORE = 0.84; // ~84th percentile confidence
const STRONG_GAP = 0.14; // Clear separation from #2

/**
 * Compute whether top-5 BM25 results are strong enough to skip expansion.
 * Returns true if top result is both confident AND clearly separated.
 */
function hasStrongBm25Signal(chunks: readonly ChunkId[]): boolean {
  if (chunks.length === 0) {
    return false;
  }

  const scores = chunks
    .slice(0, 5)
    .map((r) => normalizeBm25Score(r.score ?? 0))
    .sort((a, b) => b - a); // Descending

  const topScore = scores[0] ?? 0;
  const secondScore = scores[1] ?? 0;
  const gap = topScore - secondScore;

  // Strong signal requires BOTH: high confidence AND clear separation
  return topScore >= STRONG_TOP_SCORE && gap >= STRONG_GAP;
}

// ─────────────────────────────────────────────────────────────────────────────
// FTS Retrieval (returns ChunkIds)
// ─────────────────────────────────────────────────────────────────────────────

interface ChunkId {
  sourceDocid?: string;
  documentIds?: number[];
  mirrorHash: string;
  seq: number;
  score?: number;
}

type FtsChunksResult =
  | { ok: true; chunks: ChunkId[] }
  | { ok: false; code: "INVALID_INPUT" | "OTHER"; message: string };

async function searchFtsChunks(
  store: StorePort,
  query: string,
  options: {
    limit: number;
    collection?: string;
    collections?: string[];
    lang?: string;
    tagsAll?: string[];
    tagsAny?: string[];
    since?: string;
    until?: string;
    categories?: string[];
    author?: string;
    filter?: HybridSearchOptions["filter"];
    relPathPrefix?: string;
    allowedMirrorHashes?: string[];
    exclude?: string[];
    memoryScopesAny?: string[];
    excludeSuperseded?: boolean;
  }
): Promise<FtsChunksResult> {
  const result = await store.searchFts(query, {
    limit: options.limit,
    collection: options.collection,
    collections: options.collections,
    relPathPrefix: options.relPathPrefix,
    language: options.lang,
    chunkLanguage: options.lang,
    excludeMetadata: true,
    semanticMetadata: true,
    memoryScopesAny: options.memoryScopesAny,
    nameBoost: true,
    excludeSuperseded: options.excludeSuperseded,
    exclude: options.exclude,
    allowedMirrorHashes: options.allowedMirrorHashes,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: options.since,
    until: options.until,
    categories: options.categories,
    author: options.author,
    filter: options.filter,
  });
  if (!result.ok) {
    // Propagate INVALID_INPUT for FTS syntax errors
    const code =
      result.error.code === "INVALID_INPUT" ? "INVALID_INPUT" : "OTHER";
    return { ok: false, code, message: result.error.message };
  }
  return {
    ok: true,
    chunks: result.value.map((r) => ({
      sourceDocid: r.docid,
      mirrorHash: r.mirrorHash,
      seq: r.seq,
      score: r.score,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector Retrieval (returns ChunkIds)
// ─────────────────────────────────────────────────────────────────────────────

async function searchVectorChunks(
  vectorIndex: VectorIndexPort,
  embedPort: EmbeddingPort,
  query: string,
  options: {
    limit: number;
    minScore?: number;
    allowedMirrorHashes?: string[];
    eligibility?: VectorSearchOptions["eligibility"];
    coarseVectorSearch?: boolean;
    exact?: boolean;
    onRoute?: (info: VectorRouteInfo) => void;
  }
): Promise<
  | { ok: true; chunks: ChunkId[] }
  | { ok: false; reason: string; notice?: string }
> {
  if (!vectorIndex.searchAvailable) {
    return { ok: false, reason: "vector_unavailable" };
  }

  // Embed query with contextual formatting
  const embedResult = await embedPort.embed(
    formatQueryForEmbedding(query, embedPort.modelUri)
  );
  assertInferenceResult(embedResult);
  if (!embedResult.ok) {
    return { ok: false, reason: "vector_embed_error" };
  }

  const partition = await resolveVectorSearchIdentity(embedPort, vectorIndex);
  if (partition.unavailable)
    return {
      ok: false,
      reason: VECTOR_RUNTIME_INCOMPATIBLE,
      notice: lexicalFallbackNotice(partition.unavailable),
    };
  const queryEmbedding = new Float32Array(embedResult.value);
  const searchResult = await vectorIndex.searchNearest(
    queryEmbedding,
    options.limit,
    {
      embeddingIdentity: partition.identity,
      minScore: options.minScore,
      allowedMirrorHashes: options.allowedMirrorHashes,
      eligibility: options.eligibility,
      coarseVectorSearch: options.coarseVectorSearch,
      exact: options.exact,
      onRoute: options.onRoute,
    }
  );

  if (!searchResult.ok) {
    return { ok: false, reason: "vector_search_error" };
  }

  return {
    ok: true,
    chunks: searchResult.value.map((r) => ({
      documentIds: r.documentIds,
      mirrorHash: r.mirrorHash,
      seq: r.seq,
      score: r.distance,
    })),
  };
}

function toTraceCandidates(chunks: ChunkId[]): QueryDiagnoseTraceCandidate[] {
  return chunks.map((chunk, index) => ({
    mirrorHash: chunk.mirrorHash,
    seq: chunk.seq,
    rank: index + 1,
    score: chunk.score ?? index + 1,
  }));
}

function candidatesToTrace(
  candidates: Array<{
    mirrorHash: string;
    seq: number;
    fusionScore?: number;
    blendedScore?: number;
  }>
): QueryDiagnoseTraceCandidate[] {
  return candidates.map((candidate, index) => ({
    mirrorHash: candidate.mirrorHash,
    seq: candidate.seq,
    rank: index + 1,
    score: candidate.blendedScore ?? candidate.fusionScore ?? index + 1,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute hybrid search with full pipeline.
 */
export async function searchHybrid(
  deps: HybridSearchDeps,
  query: string,
  options: HybridSearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  if (options.filter !== undefined)
    options = {
      ...options,
      filter: normalizeMetadataPredicate(options.filter),
    };
  const hydration = deps.hydration ?? new RequestHydration(deps.store);
  try {
    return await withInferenceScope(options, () =>
      searchHybridWithHydration(deps, query, options, hydration)
    );
  } catch (cause) {
    if (cause instanceof OwnerMetadataError)
      return err("QUERY_FAILED", cause.message);
    throw cause;
  } finally {
    if (!deps.hydration) hydration.release();
  }
}

// oxlint-disable-next-line max-lines-per-function -- search orchestration with BM25, vector, fusion, reranking
async function searchHybridWithHydration(
  deps: HybridSearchDeps,
  query: string,
  options: HybridSearchOptions,
  hydration: RequestHydration
): Promise<ReturnType<typeof ok<SearchResults>>> {
  const runStartedAt = performance.now();
  const { store, vectorIndex, embedPort, expandPort, rerankPort } = deps;
  const pipelineConfig = deps.pipelineConfig ?? DEFAULT_PIPELINE_CONFIG;
  const contentTypeRules =
    options.contentTypeRules ??
    normalizeContentTypes(deps.config.contentTypes ?? []).rules;
  const auxiliaryRankingActive = hasAuxiliaryRanking(
    options.projectAffinity,
    contentTypeRules
  );

  const limit = options.limit ?? 20;
  const recencySort = shouldSortByRecency(query);
  const temporalRange = resolveTemporalRange(
    query,
    options.since,
    options.until
  );
  const explainLines: ExplainLine[] = [];
  let expansion: ExpansionResult | null = null;
  const timings = {
    langMs: 0,
    expansionMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
    graphMs: 0,
    fusionMs: 0,
    rerankMs: 0,
    assemblyMs: 0,
    totalMs: 0,
  };
  const counters = {
    expansionCacheHits: 0,
    expansionCacheLookups: 0,
    rerankCacheHits: 0,
    rerankCacheLookups: 0,
    fallbackEvents: [] as string[],
  };

  // Increase retrieval limits when post-retrieval filters are active.
  const hasPostFilters = Boolean(
    options.tagsAll?.length ||
    options.tagsAny?.length ||
    options.categories?.length ||
    options.author ||
    temporalRange.since ||
    temporalRange.until
  );
  const retrievalMultiplier = hasPostFilters || recencySort ? 3 : 1;

  // ─────────────────────────────────────────────────────────────────────────
  // 0. Detect query language for PROMPT SELECTION only
  //    CRITICAL: Detection does NOT change retrieval filters - options.lang does
  //    Priority: queryLanguageHint (MCP) > lang (CLI) > detection
  // ─────────────────────────────────────────────────────────────────────────
  const langStartedAt = performance.now();
  let queryLanguage: string;
  let langMessage: string;
  if (options.queryLanguageHint) {
    queryLanguage = options.queryLanguageHint;
    langMessage = `queryLanguage=${queryLanguage} (hint)`;
  } else if (options.lang) {
    queryLanguage = options.lang;
    langMessage = `queryLanguage=${queryLanguage} (explicit)`;
  } else {
    const detection = detectQueryLanguage(query);
    queryLanguage = detection.bcp47;
    const confidence = detection.confident ? "" : ", low confidence";
    langMessage = `queryLanguage=${queryLanguage} (detected${confidence})`;
  }
  explainLines.push({ stage: "lang", message: langMessage });
  timings.langMs = performance.now() - langStartedAt;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Original BM25 query (once; fail-fast on INVALID_INPUT) + expansion
  // ─────────────────────────────────────────────────────────────────────────
  const shouldExpand = !options.noExpand && expandPort !== null;
  let expansionStatus: ExpansionStatus = "disabled";
  let queryModeSummary: ReturnType<typeof summarizeQueryModes> | undefined =
    undefined;

  if (options.queryModes?.length) {
    queryModeSummary = summarizeQueryModes(options.queryModes);
    explainLines.push(explainQueryModes(queryModeSummary));
    expansion = buildExpansionFromQueryModes(options.queryModes);
    expansionStatus = "provided";
  }

  const bm25BaseOptions = {
    collection: options.collection,
    collections: options.collections,
    lang: options.lang,
    memoryScopesAny: options.memoryFilter?.scopes,
    excludeSuperseded: options.memoryFilter?.excludeSuperseded,
    exclude: options.exclude,
    allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: temporalRange.since,
    until: temporalRange.until,
    categories: options.categories,
    author: options.author,
    filter: options.filter,
    relPathPrefix: options.retrievalScope?.relPathPrefix,
  };
  const needsStrengthCheck =
    expansionStatus !== "provided" && shouldExpand && !options.intent?.trim();
  const originalBm25TargetLimit = limit * 2 * retrievalMultiplier;
  const bm25InitialStartedAt = performance.now();
  const bm25Result = await searchFtsChunks(store, query, {
    ...bm25BaseOptions,
    limit: needsStrengthCheck
      ? Math.max(5, originalBm25TargetLimit)
      : originalBm25TargetLimit,
  });
  timings.bm25Ms = performance.now() - bm25InitialStartedAt;

  // Propagate FTS syntax errors as INVALID_INPUT before invoking LLM expansion
  if (!bm25Result.ok && bm25Result.code === "INVALID_INPUT") {
    return err("INVALID_INPUT", `Invalid search query: ${bm25Result.message}`);
  }
  const bm25AllChunks = bm25Result.ok ? bm25Result.chunks : [];
  const bm25Chunks = bm25AllChunks.slice(0, originalBm25TargetLimit);
  const bm25Count = bm25Chunks.length;

  const expansionStartedAt = performance.now();
  if (expansionStatus !== "provided" && shouldExpand) {
    const hasStrongSignal = options.intent?.trim()
      ? false
      : hasStrongBm25Signal(bm25AllChunks);

    if (hasStrongSignal) {
      expansionStatus = "skipped_strong";
      counters.fallbackEvents.push("expansion_skipped_strong");
    } else {
      expansionStatus = "attempted";
      const expandOptions = {
        // Use queryLanguage for prompt selection, NOT options.lang (retrieval filter)
        lang: queryLanguage,
        intent: options.intent,
        contextSize: deps.config.models?.expandContextSize,
      };
      const expandResult =
        typeof store.getLlmCache === "function" &&
        typeof store.setLlmCache === "function"
          ? await expandQueryCached(
              {
                genPort: expandPort,
                getCache: async (key) => {
                  const res = await store.getLlmCache!(key);
                  return res.ok ? res.value : null;
                },
                setCache: async (key, value) => {
                  await store.setLlmCache!(key, value);
                },
                onCacheLookup: () => {
                  counters.expansionCacheLookups += 1;
                },
                onCacheHit: () => {
                  counters.expansionCacheHits += 1;
                },
              },
              query,
              expandOptions
            )
          : await expandQuery(expandPort, query, expandOptions);
      if (expandResult.ok) {
        expansion = expandResult.value;
      } else {
        counters.fallbackEvents.push("expansion_error");
      }
    }
  }
  if (expansionStatus === "disabled") {
    counters.fallbackEvents.push("expansion_disabled");
  }

  explainLines.push(explainExpansion(expansionStatus, expansion));
  timings.expansionMs = performance.now() - expansionStartedAt;

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Concurrent retrieval: lexical variants + vector leg
  // ─────────────────────────────────────────────────────────────────────────
  const rankedInputs: RankedInput[] = [];
  const diagnoseTrace: QueryDiagnoseTrace | undefined = options.diagnoseTrace
    ? { stages: [] }
    : undefined;

  const vectorEligibility: VectorSearchOptions["eligibility"] = {
    collection: options.collection,
    collections: options.collections,
    memoryScopesAny: options.memoryFilter?.scopes,
    excludeSuperseded: options.memoryFilter?.excludeSuperseded,
    relPathPrefix: options.retrievalScope?.relPathPrefix,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: temporalRange.since,
    until: temporalRange.until,
    categories: options.categories,
    author: options.author,
    filter: options.filter,
    exclude: options.exclude,
    excludeMetadata: true,
    semanticMetadata: true,
    language: options.lang,
  };

  diagnoseTrace?.stages.push({
    id: "bm25",
    status: "active",
    sourceCount: 1,
    candidates: toTraceCandidates(bm25Chunks),
  });
  if (bm25Count > 0) {
    rankedInputs.push(toRankedInput("bm25", bm25Chunks));
  }

  const vectorAvailable =
    (vectorIndex?.searchAvailable && embedPort !== null) ?? false;

  const runLexicalVariants = async (): Promise<{
    inputs: RankedInput[];
    durationMs: number;
  }> => {
    const lexicalQueries = expansion?.lexicalQueries;
    if (!lexicalQueries?.length) {
      return { inputs: [], durationMs: 0 };
    }
    const started = performance.now();
    const trimmedQuery = query.trim();
    const variantLimit = limit * retrievalMultiplier;
    const settledResults = await Promise.allSettled(
      lexicalQueries.map((variant) => {
        if (variant.trim() === trimmedQuery) {
          return Promise.resolve<FtsChunksResult>(
            bm25Result.ok
              ? {
                  ok: true,
                  chunks: bm25AllChunks.slice(0, variantLimit),
                }
              : bm25Result
          );
        }
        return searchFtsChunks(store, variant, {
          ...bm25BaseOptions,
          limit: variantLimit,
        });
      })
    );
    const inputs: RankedInput[] = [];
    for (const settled of settledResults) {
      assertInferenceActive();
      if (settled.status !== "fulfilled") continue;
      const variantResult = settled.value;
      if (variantResult.ok && variantResult.chunks.length > 0) {
        inputs.push(toRankedInput("bm25_variant", variantResult.chunks));
      }
    }
    return { inputs, durationMs: performance.now() - started };
  };

  const runVectorLeg = async (): Promise<{
    inputs: RankedInput[];
    traceChunks: ChunkId[];
    vecCount: number;
    vectorsUsed: boolean;
    vectorNotice?: string;
    vectorRoute?: VectorRouteInfo;
    fallbacks: string[];
    durationMs: number;
  }> => {
    const fallbacks: string[] = [];
    if (!vectorAvailable || !vectorIndex || !embedPort) {
      fallbacks.push("vector_unavailable");
      return {
        inputs: [],
        traceChunks: [],
        vecCount: 0,
        vectorsUsed: false,
        fallbacks,
        durationMs: 0,
      };
    }

    const started = performance.now();
    const inputs: RankedInput[] = [];
    const traceChunks: ChunkId[] = [];
    let localVecCount = 0;
    let localVectorsUsed = false;
    let localNotice: string | undefined;
    let localVectorRoute: VectorRouteInfo | undefined;

    const vectorVariantQueries = [
      ...(expansion?.vectorQueries?.map((q) => ({
        source: "vector_variant" as const,
        query: q,
      })) ?? []),
      ...(expansion?.hyde
        ? [{ source: "hyde" as const, query: expansion.hyde }]
        : []),
    ];

    if (vectorVariantQueries.length === 0) {
      const vectorResult = await searchVectorChunks(
        vectorIndex,
        embedPort,
        query,
        {
          limit: limit * 2 * retrievalMultiplier,
          allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
          eligibility: vectorEligibility,
          coarseVectorSearch:
            options.coarseVectorSearch ?? deps.config.coarseVectorSearch,
          exact: options.exactVectorSearch,
          onRoute: (info) => {
            localVectorRoute = info;
          },
        }
      );

      if (!vectorResult.ok) {
        fallbacks.push(vectorResult.reason);
        localNotice = vectorResult.notice;
      } else {
        localVectorsUsed = true;
      }
      const vecChunks = vectorResult.ok ? vectorResult.chunks : [];
      localVecCount = vecChunks.length;
      traceChunks.push(...vecChunks);
      if (localVecCount > 0) {
        inputs.push(toRankedInput("vector", vecChunks));
      }
    } else {
      const batchedQueries = [
        {
          source: "vector" as const,
          query,
          limit: limit * 2 * retrievalMultiplier,
        },
        ...vectorVariantQueries.map((variant) => ({
          ...variant,
          limit: limit * retrievalMultiplier,
        })),
      ];

      // Deduplicate identical formatted query strings before embedding & searching,
      // retaining every variant's RRF input contribution via per-variant slicing.
      const uniqueFormatted: string[] = [];
      const uniqueMaxLimits: number[] = [];
      const formattedToUniqueIdx = new Map<string, number>();
      const variantToUniqueIdx: number[] = [];
      for (const variant of batchedQueries) {
        const formatted = formatQueryForEmbedding(
          variant.query,
          embedPort.modelUri
        );
        let uIdx = formattedToUniqueIdx.get(formatted);
        if (uIdx === undefined) {
          uIdx = uniqueFormatted.length;
          formattedToUniqueIdx.set(formatted, uIdx);
          uniqueFormatted.push(formatted);
          uniqueMaxLimits.push(variant.limit);
        } else if (variant.limit > uniqueMaxLimits[uIdx]!) {
          uniqueMaxLimits[uIdx] = variant.limit;
        }
        variantToUniqueIdx.push(uIdx);
      }

      const embedResult = await embedTextsWithRecovery(
        embedPort,
        uniqueFormatted
      );

      assertInferenceResult(embedResult);
      const partition = embedResult.ok
        ? await resolveVectorSearchIdentity(embedPort, vectorIndex)
        : undefined;
      if (!embedResult.ok) {
        fallbacks.push("vector_embed_error");
      } else if (partition?.unavailable) {
        fallbacks.push(VECTOR_RUNTIME_INCOMPATIBLE);
        localNotice = lexicalFallbackNotice(partition.unavailable);
      } else {
        if (embedResult.value.batchFailed) {
          fallbacks.push("vector_embed_batch_fallback");
        }

        const searchOpts: VectorSearchOptions = {
          embeddingIdentity: partition?.identity,
          allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
          eligibility: vectorEligibility,
          coarseVectorSearch:
            options.coarseVectorSearch ?? deps.config.coarseVectorSearch,
          exact: options.exactVectorSearch,
          onRoute: (info) => {
            localVectorRoute = info;
          },
        };
        const uniqueResults = new Map<number, ChunkId[]>();
        const uniqueFailed = new Set<number>();

        const validUniqueIndices: number[] = [];
        const validEmbeddings: Float32Array[] = [];
        const validLimits: number[] = [];
        for (let uIdx = 0; uIdx < uniqueFormatted.length; uIdx++) {
          const emb = embedResult.value.vectors[uIdx];
          if (!emb) continue;
          validUniqueIndices.push(uIdx);
          validEmbeddings.push(new Float32Array(emb));
          validLimits.push(uniqueMaxLimits[uIdx]!);
        }

        const runIndividualSearches = async (): Promise<void> => {
          for (let i = 0; i < validUniqueIndices.length; i++) {
            assertInferenceActive();
            const uIdx = validUniqueIndices[i]!;
            const searchResult = await vectorIndex.searchNearest(
              validEmbeddings[i]!,
              validLimits[i]!,
              searchOpts
            );
            if (!searchResult.ok) {
              uniqueFailed.add(uIdx);
              continue;
            }
            localVectorsUsed = true;
            uniqueResults.set(
              uIdx,
              searchResult.value.map((item) => ({
                documentIds: item.documentIds,
                mirrorHash: item.mirrorHash,
                seq: item.seq,
              }))
            );
          }
        };

        if (
          typeof vectorIndex.searchNearestBatch === "function" &&
          validEmbeddings.length > 1
        ) {
          assertInferenceActive();
          const batchRes = await vectorIndex.searchNearestBatch(
            validEmbeddings,
            validLimits,
            searchOpts
          );
          if (batchRes.ok) {
            localVectorsUsed = true;
            for (let i = 0; i < validUniqueIndices.length; i++) {
              const uIdx = validUniqueIndices[i]!;
              const hits = batchRes.value[i] ?? [];
              uniqueResults.set(
                uIdx,
                hits.map((item) => ({
                  documentIds: item.documentIds,
                  mirrorHash: item.mirrorHash,
                  seq: item.seq,
                }))
              );
            }
          } else {
            // Preserve per-query isolation: retry unique embeddings individually so
            // one bad variant cannot discard healthy vector legs.
            await runIndividualSearches();
          }
        } else {
          await runIndividualSearches();
        }

        for (const [index, variant] of batchedQueries.entries()) {
          assertInferenceActive();
          const uIdx = variantToUniqueIdx[index]!;
          if (uniqueFailed.has(uIdx)) {
            fallbacks.push("vector_search_error");
            continue;
          }
          const fullChunks = uniqueResults.get(uIdx);
          if (!fullChunks || fullChunks.length === 0) continue;
          const chunks = fullChunks.slice(0, variant.limit);
          if (variant.source === "vector") {
            localVecCount = chunks.length;
          }
          traceChunks.push(...chunks);
          if (chunks.length === 0) continue;
          inputs.push(toRankedInput(variant.source, chunks));
        }
      }
    }

    return {
      inputs,
      traceChunks,
      vecCount: localVecCount,
      vectorsUsed: localVectorsUsed,
      vectorNotice: localNotice,
      vectorRoute: localVectorRoute,
      fallbacks,
      durationMs: performance.now() - started,
    };
  };

  // Run lexical expansion variants concurrently with out-of-process vector leg;
  // Promise.allSettled guarantees no unhandled rejections on abort/timeout.
  const [lexSettled, vecSettled] = await Promise.allSettled([
    runLexicalVariants(),
    runVectorLeg(),
  ]);
  if (lexSettled.status === "rejected") throw lexSettled.reason;
  if (vecSettled.status === "rejected") throw vecSettled.reason;

  const lexOutcome = lexSettled.value;
  const vecOutcome = vecSettled.value;
  rankedInputs.push(...lexOutcome.inputs);
  timings.bm25Ms += lexOutcome.durationMs;
  explainLines.push(explainBm25(bm25Count));

  const vecCount = vecOutcome.vecCount;
  const vectorsUsed = vecOutcome.vectorsUsed;
  const vectorNotice = vecOutcome.vectorNotice;
  counters.fallbackEvents.push(...vecOutcome.fallbacks);
  rankedInputs.push(...vecOutcome.inputs);
  timings.vectorMs = vecOutcome.durationMs;

  diagnoseTrace?.stages.push({
    id: "vector",
    status: vectorAvailable ? "active" : "skipped",
    reason: vectorAvailable ? undefined : "vector_unavailable",
    sourceCount: vectorAvailable ? 1 : 0,
    candidates: toTraceCandidates(vecOutcome.traceChunks),
  });

  explainLines.push(
    explainVector(
      vecCount,
      vectorAvailable,
      vectorIndex?.loadError,
      vectorIndex?.guidance,
      vecOutcome.vectorRoute
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 3. RRF Fusion
  // ─────────────────────────────────────────────────────────────────────────
  const fusionStartedAt = performance.now();
  const candidateLimit =
    options.candidateLimit ?? pipelineConfig.rerankCandidates;
  const hasVariantOwners = rankedInputs.some((input) =>
    input.results.some((result) => result.documentId !== undefined)
  );
  const resolvedInputs = await resolveFusionOwners(
    rankedInputs,
    store,
    hydration,
    query,
    options
  );
  let fusedCandidates = rrfFuse(resolvedInputs, pipelineConfig.rrf);
  diagnoseTrace?.stages.push({
    id: "fusion",
    status: "active",
    sourceCount: rankedInputs.length,
    candidates: candidatesToTrace(fusedCandidates),
  });

  timings.fusionMs = performance.now() - fusionStartedAt;
  const graphStartedAt = performance.now();
  const graphExpansion = await expandGraphCandidates(
    store,
    fusedCandidates,
    {
      collection: options.collection,
      collections: options.graphCollections ?? options.collections,
      includeSimilar: vectorAvailable,
      eligibility: vectorEligibility,
      limit,
      candidateLimit,
      disabled: options.graph === false || options.noGraph === true,
      relPathPrefix: options.retrievalScope?.relPathPrefix,
      lang: options.lang,
      tagsAll: options.tagsAll,
      tagsAny: options.tagsAny,
      since: temporalRange.since,
      until: temporalRange.until,
      categories: options.categories,
      author: options.author,
      filter: options.filter,
    },
    hydration
  );
  timings.graphMs = performance.now() - graphStartedAt;
  if (graphExpansion.candidates.length > 0) {
    const graphFusionStartedAt = performance.now();
    const graphInput = toRankedInput("graph", graphExpansion.candidates);
    const resolvedGraph = hasVariantOwners
      ? await resolveFusionOwners(
          [graphInput],
          store,
          hydration,
          query,
          options,
          true
        )
      : [graphInput];
    const finalResolvedInputs = [...resolvedInputs, ...resolvedGraph];
    fusedCandidates = rrfFuse(finalResolvedInputs, pipelineConfig.rrf);
    timings.fusionMs += performance.now() - graphFusionStartedAt;
  }
  diagnoseTrace?.stages.push({
    id: "graph",
    status: graphExpansion.meta.attempted ? "active" : "skipped",
    reason: graphExpansion.meta.attempted
      ? undefined
      : graphExpansion.meta.fallbackReasons.join(", ") || "disabled",
    sourceCount: graphExpansion.meta.attempted ? 1 : 0,
    candidates: graphExpansion.candidates.map((candidate, index) => ({
      mirrorHash: candidate.mirrorHash,
      seq: candidate.seq,
      rank: index + 1,
      score: index + 1,
    })),
  });
  if (graphExpansion.meta.fallbackReasons.length > 0) {
    counters.fallbackEvents.push(...graphExpansion.meta.fallbackReasons);
  }
  explainLines.push({
    stage: "graph",
    message: graphExpansion.meta.attempted
      ? `seeds=${graphExpansion.meta.seedCount}, candidates=${graphExpansion.meta.candidateCount}/${graphExpansion.meta.maxCandidates}, explicit=${graphExpansion.meta.edgeConfidence.explicit}, inferred=${graphExpansion.meta.edgeConfidence.inferred}, ambiguous=${graphExpansion.meta.edgeConfidence.ambiguous}, similarity=${graphExpansion.meta.edgeConfidence.similarity}`
      : `skipped (${graphExpansion.meta.fallbackReasons.join(", ") || "disabled"})`,
  });
  explainLines.push(
    explainFusion(pipelineConfig.rrf.k, fusedCandidates.length)
  );

  // Auxiliary scores enter after fusion normalization and before rerank
  // blending. The reranker therefore remains the final ordering authority,
  // including its lexical top-hit guardrail.
  let prefetchedDocuments: DocumentRow[] | undefined;
  const auxiliaryBaseScores = new Map<string, number>();
  const preRerankAdjustedCandidates = new Set<string>();
  let adjustNormalizedFusionScore:
    | ((
        candidate: (typeof fusedCandidates)[number],
        normalizedScore: number
      ) => number)
    | undefined;
  if (auxiliaryRankingActive) {
    const prefetchedDocumentsResult =
      await hydration.getDocumentsByMirrorHashes(
        [...new Set(fusedCandidates.map((candidate) => candidate.mirrorHash))],
        {
          collection: options.collection,
          collections: options.collections,
          activeOnly: true,
        }
      );
    if (!prefetchedDocumentsResult.ok) {
      return err("QUERY_FAILED", prefetchedDocumentsResult.error.message);
    }
    prefetchedDocuments = prefetchedDocumentsResult.value;
    const scoringDocumentsByHash = new Map<string, DocumentRow[]>();
    for (const document of [...prefetchedDocuments].sort((left, right) => {
      if (left.uri !== right.uri) return left.uri.localeCompare(right.uri);
      return left.docid.localeCompare(right.docid);
    })) {
      if (!document.mirrorHash) continue;
      const documents = scoringDocumentsByHash.get(document.mirrorHash) ?? [];
      documents.push(document);
      scoringDocumentsByHash.set(document.mirrorHash, documents);
    }
    adjustNormalizedFusionScore = (candidate, normalizedScore) => {
      const candidateKey = `${candidate.mirrorHash}:${candidate.seq}:${candidate.documentId ?? ""}`;
      auxiliaryBaseScores.set(candidateKey, normalizedScore);
      const documents = scoringDocumentsByHash
        .get(candidate.mirrorHash)
        ?.filter(
          (doc) =>
            candidate.documentId === undefined ||
            candidate.documentId === doc.id
        );
      if (!documents?.length) return normalizedScore;
      const projectedScores = documents.map(
        (document) =>
          scoreContentTypeBoost(
            normalizedScore,
            document.contentType ?? undefined,
            document.contentTypeSource,
            document.relPath,
            document.collection,
            contentTypeRules,
            options.projectAffinity,
            { kind: "hybrid_blended", score: normalizedScore }
          ).projectAffinity.finalScore
      );
      const agreedScore = projectedScores[0] ?? normalizedScore;
      const projectionsAgree = projectedScores.every(
        (score) => Math.abs(score - agreedScore) < 1e-9
      );
      if (!projectionsAgree) return normalizedScore;
      preRerankAdjustedCandidates.add(candidateKey);
      return agreedScore;
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Reranking
  // ─────────────────────────────────────────────────────────────────────────
  const rerankStartedAt = performance.now();
  const rerankResult = await rerankCandidates(
    { rerankPort: options.noRerank ? null : rerankPort, store, hydration },
    query,
    fusedCandidates,
    {
      maxCandidates: candidateLimit,
      blendingSchedule: pipelineConfig.blendingSchedule,
      intent: options.intent,
      adjustNormalizedFusionScore,
    }
  );
  if (rerankResult.fallbackReason === "disabled") {
    counters.fallbackEvents.push("rerank_disabled");
  } else if (rerankResult.fallbackReason === "error") {
    counters.fallbackEvents.push("rerank_error");
  }
  timings.rerankMs = performance.now() - rerankStartedAt;

  diagnoseTrace?.stages.push({
    id: "rerank",
    status: rerankResult.reranked ? "active" : "skipped",
    reason: rerankResult.reranked
      ? undefined
      : (rerankResult.fallbackReason ?? "disabled"),
    sourceCount: rerankResult.reranked ? 1 : 0,
    candidates: candidatesToTrace(rerankResult.candidates),
  });

  explainLines.push(
    explainRerank(!options.noRerank && rerankPort !== null, candidateLimit)
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 4b. Apply minScore filter (blendedScore is now normalized to [0,1])
  // ─────────────────────────────────────────────────────────────────────────
  const minScore = options.minScore ?? 0;
  const filteredCandidates =
    minScore > 0 && !auxiliaryRankingActive
      ? rerankResult.candidates.filter((c) => c.blendedScore >= minScore)
      : rerankResult.candidates;

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Build final results (optimized: batch lookups, no per-candidate queries)
  // ─────────────────────────────────────────────────────────────────────────

  const assemblyStartedAt = performance.now();

  // Collect unique mirrorHashes needed from candidates.
  const neededHashes = new Set(filteredCandidates.map((c) => c.mirrorHash));

  // Fetch only needed documents and collections.
  let documents = prefetchedDocuments;
  if (!documents) {
    const docsResult = await hydration.getDocumentsByMirrorHashes(
      [...neededHashes],
      {
        collection: options.collection,
        collections: options.collections,
        activeOnly: true,
      }
    );
    if (!docsResult.ok) {
      return err("QUERY_FAILED", docsResult.error.message);
    }
    documents = docsResult.value;
  }
  const collectionsResult = await store.getCollections();

  // Build lookup maps with pre-compiled query-invariant filters.
  const compiledFilters = compileDocumentFilters(
    query,
    options,
    undefined,
    compileTemporalRange(temporalRange)
  );
  const docsByMirrorHash = new Map<string, DocumentRow[]>();
  const addDocument = (doc: DocumentRow): void => {
    if (!doc.mirrorHash) return;
    const docs = docsByMirrorHash.get(doc.mirrorHash) ?? [];
    docs.push(doc);
    docsByMirrorHash.set(doc.mirrorHash, docs);
  };
  const matchesMetadataFilters = (doc: DocumentRow): boolean => {
    if (typedMetadataFilterReason(doc, options.filter)) {
      return false;
    }
    const relPathPrefix = options.retrievalScope?.relPathPrefix;
    const sourceRelPath = doc.recordSourcePath ?? doc.relPath;
    if (
      relPathPrefix !== undefined &&
      sourceRelPath !== relPathPrefix &&
      !sourceRelPath.startsWith(`${relPathPrefix}/`)
    ) {
      return false;
    }
    if (
      !isWithinTemporalRange(doc.sourceMtime, compiledFilters.temporalRange)
    ) {
      return false;
    }
    if (
      compiledFilters.authorLower &&
      !doc.author?.toLowerCase().includes(compiledFilters.authorLower)
    ) {
      return false;
    }
    if (compiledFilters.allowedCategories) {
      const contentTypeMatch = doc.contentType
        ? compiledFilters.allowedCategories.has(doc.contentType.toLowerCase())
        : false;
      const categoryMatch = (doc.categories ?? []).some((c) =>
        compiledFilters.allowedCategories!.has(c.toLowerCase())
      );
      if (!contentTypeMatch && !categoryMatch) {
        return false;
      }
    }
    return true;
  };

  // Collect doc IDs that need tag filtering
  const needsTagFilter = options.tagsAll?.length || options.tagsAny?.length;
  const docIdsForTagCheck: number[] = [];
  const candidateDocs: DocumentRow[] = [];

  for (const doc of documents) {
    assertInferenceActive();
    if (!doc.mirrorHash) {
      continue;
    }
    if (!matchesMetadataFilters(doc)) {
      continue;
    }
    if (needsTagFilter) {
      docIdsForTagCheck.push(doc.id);
      candidateDocs.push(doc);
    } else {
      addDocument(doc);
    }
  }

  // Apply tag filters if needed (batch fetch to avoid N+1)
  if (needsTagFilter && docIdsForTagCheck.length > 0) {
    const tagsResult = await store.getTagsBatch(docIdsForTagCheck);
    if (tagsResult.ok) {
      const tagsByDocId = tagsResult.value;
      for (const doc of candidateDocs) {
        assertInferenceActive();
        const docTags = new Set(
          (tagsByDocId.get(doc.id) ?? []).map((t) => t.tag)
        );

        // tagsAll: doc must have ALL specified tags
        if (options.tagsAll?.length) {
          const hasAll = options.tagsAll.every((t) => docTags.has(t));
          if (!hasAll) continue;
        }

        // tagsAny: doc must have at least one of the specified tags
        if (options.tagsAny?.length) {
          const hasAny = options.tagsAny.some((t) => docTags.has(t));
          if (!hasAny) continue;
        }

        addDocument(doc);
      }
    }
  }

  for (const docs of docsByMirrorHash.values()) {
    assertInferenceActive();
    docs.sort((left, right) => {
      if (left.uri < right.uri) return -1;
      if (left.uri > right.uri) return 1;
      return left.docid < right.docid ? -1 : left.docid > right.docid ? 1 : 0;
    });
  }

  const collectionPaths = new Map<string, string>();
  if (collectionsResult.ok) {
    for (const c of collectionsResult.value) {
      assertInferenceActive();
      collectionPaths.set(c.name, c.path);
    }
  }

  // Pre-fetch chunks: use sequence-scoped loading when neither intent nor
  // exclude needs full chunk sets, reusing already-hydrated hashes when warm.
  const needsAllChunksForAssembly = Boolean(
    options.intent?.trim() || options.exclude?.length
  );
  let chunksMap: Map<string, import("../store/types").ChunkRow[]>;
  if (
    !needsAllChunksForAssembly &&
    typeof store.getChunksBySequenceBatch === "function"
  ) {
    const cachedHashes: string[] = [];
    const uncachedSeqRequests: Array<{ mirrorHash: string; seq: number }> = [];
    const seenReq = new Set<string>();
    for (const candidate of filteredCandidates) {
      if (hydration.hasChunks(candidate.mirrorHash)) {
        cachedHashes.push(candidate.mirrorHash);
      } else {
        const reqKey = `${candidate.mirrorHash}:${candidate.seq}`;
        if (!seenReq.has(reqKey)) {
          seenReq.add(reqKey);
          uncachedSeqRequests.push({
            mirrorHash: candidate.mirrorHash,
            seq: candidate.seq,
          });
        }
      }
    }
    const [cachedRes, seqRes] = await Promise.all([
      cachedHashes.length > 0
        ? hydration.getChunksBatch(cachedHashes)
        : Promise.resolve(
            ok(new Map<string, import("../store/types").ChunkRow[]>())
          ),
      uncachedSeqRequests.length > 0
        ? store.getChunksBySequenceBatch(uncachedSeqRequests)
        : Promise.resolve(
            ok(new Map<string, import("../store/types").ChunkRow[]>())
          ),
    ]);
    if (!cachedRes.ok) {
      return err("QUERY_FAILED", cachedRes.error.message);
    }
    if (!seqRes.ok) {
      return err("QUERY_FAILED", seqRes.error.message);
    }
    chunksMap = new Map(cachedRes.value);
    for (const [hash, rows] of seqRes.value) {
      chunksMap.set(hash, rows);
    }
    // For doc-level FTS (seq=0) missing seq=0, fall back to full batch for only those hashes.
    const missingSeqZeroHashes: string[] = [];
    for (const req of uncachedSeqRequests) {
      if (req.seq === 0 && (chunksMap.get(req.mirrorHash)?.length ?? 0) === 0) {
        missingSeqZeroHashes.push(req.mirrorHash);
      }
    }
    if (missingSeqZeroHashes.length > 0) {
      const fallbackRes = await hydration.getChunksBatch(missingSeqZeroHashes);
      if (!fallbackRes.ok) {
        return err("QUERY_FAILED", fallbackRes.error.message);
      }
      for (const [hash, rows] of fallbackRes.value) {
        chunksMap.set(hash, rows);
      }
    }
  } else {
    const chunksMapResult = await hydration.getChunksBatch([...neededHashes]);
    if (!chunksMapResult.ok) {
      return err("QUERY_FAILED", chunksMapResult.error.message);
    }
    chunksMap = chunksMapResult.value;
  }
  const getChunk = createChunkLookup(chunksMap);
  const excludeTermsLower = compiledFilters.excludeTermsLower;
  const excludedChunksCache = excludeTermsLower
    ? new Map<string, boolean>()
    : undefined;
  const queryTerms = options.intent?.trim()
    ? extractSteeringTerms(query)
    : undefined;
  const intentTerms = options.intent?.trim()
    ? extractSteeringTerms(options.intent)
    : undefined;

  const results: SearchResult[] = [];
  const deferredChunkTextByResult = new WeakMap<SearchResult, string>();
  const assemblyLimit = recencySort ? limit * 3 : limit;
  const docidMap = new Map<string, string>();
  // Track seen docids for --full de-duplication
  const seenDocids = new Set<string>();

  // Iterate until we have enough results (don't slice early - deduping may skip candidates)
  for (const [candidateIndex, candidate] of filteredCandidates.entries()) {
    assertInferenceActive();
    // Stop when we have enough results
    if (!auxiliaryRankingActive && results.length >= assemblyLimit) {
      break;
    }

    // Find document from pre-fetched map
    const candidateDocsForHit = (
      docsByMirrorHash.get(candidate.mirrorHash) ?? []
    ).filter(
      (doc) =>
        candidate.documentId === undefined || candidate.documentId === doc.id
    );
    if (candidateDocsForHit.length === 0) {
      continue;
    }

    const docChunks = chunksMap.get(candidate.mirrorHash) ?? [];
    // Get chunk via O(1) lookup
    // For doc-level FTS (seq=0), fall back to first available chunk if exact lookup fails
    let chunk = getChunk(candidate.mirrorHash, candidate.seq);
    if (!chunk && candidate.seq === 0) {
      // Doc-level FTS uses seq=0 as placeholder - try first chunk
      chunk = docChunks[0];
    }
    if (!chunk) {
      continue;
    }

    // STRICT --lang filter: require exact match (excludes null/undefined)
    if (options.lang && chunk.language !== options.lang) {
      continue;
    }

    if (excludeTermsLower) {
      let chunksExcluded = excludedChunksCache!.get(candidate.mirrorHash);
      if (chunksExcluded === undefined) {
        chunksExcluded = matchesExcludedChunks(
          docChunks,
          excludeTermsLower,
          true
        );
        excludedChunksCache!.set(candidate.mirrorHash, chunksExcluded);
      }
      if (chunksExcluded) continue;
    }

    const snippetChunk =
      options.full || !options.intent?.trim()
        ? chunk
        : (selectBestChunkForSteering(
            docChunks.filter(
              (c) => !options.lang || c.language === options.lang
            ),
            query,
            options.intent,
            {
              preferredSeq: chunk.seq,
              intentWeight: 0.3,
              queryTerms,
              intentTerms,
            }
          ) ?? chunk);

    let snippet = snippetChunk.text;
    let snippetStartLine = snippetChunk.startLine;
    let snippetRange: { startLine: number; endLine: number } | undefined = {
      startLine: snippetChunk.startLine,
      endLine: snippetChunk.endLine,
    };

    if (!options.full) {
      const cleanedSnippet = cleanDisplaySnippet(
        snippetChunk.text,
        snippetChunk.text
      );
      snippet = cleanedSnippet.text;
      snippetStartLine =
        snippetChunk.startLine + cleanedSnippet.startLineOffset;
      snippetRange = {
        startLine: snippetStartLine,
        endLine: snippetChunk.endLine,
      };
    }

    for (const doc of candidateDocsForHit) {
      assertInferenceActive();
      if (!auxiliaryRankingActive && results.length >= assemblyLimit) break;
      if (
        excludeTermsLower &&
        matchesExcludedText(
          [
            doc.title ?? "",
            doc.recordSourcePath ?? doc.relPath,
            doc.author ?? "",
            doc.contentType ?? "",
            ...(doc.categories ?? []),
          ],
          excludeTermsLower,
          true
        )
      ) {
        continue;
      }
      if (
        options.full &&
        !auxiliaryRankingActive &&
        seenDocids.has(doc.docid)
      ) {
        continue;
      }
      const docidKey = `${candidate.mirrorHash}:${candidate.seq}${candidate.documentId === undefined ? "" : `:${candidate.documentId}`}`;
      if (!docidMap.has(docidKey)) docidMap.set(docidKey, doc.docid);
      const collectionPath = collectionPaths.get(doc.collection);
      if (options.full && !auxiliaryRankingActive) {
        seenDocids.add(doc.docid);
      }
      const baseResult: SearchResult = {
        docid: doc.docid,
        score: candidate.blendedScore,
        uri: doc.uri,
        title: doc.title ?? undefined,
        contentType: doc.contentType ?? undefined,
        categories: doc.categories ?? undefined,
        line: snippetStartLine,
        snippet,
        snippetLanguage: chunk.language ?? undefined,
        snippetRange,
        source: {
          relPath: doc.recordSourcePath ?? doc.relPath,
          absPath: collectionPath
            ? `${collectionPath}/${doc.recordSourcePath ?? doc.relPath}`
            : undefined,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
          modifiedAt: doc.sourceMtime,
          documentDate: doc.frontmatterDate ?? undefined,
          sizeBytes: doc.sourceSize,
          sourceHash: doc.sourceHash,
        },
        conversion: {
          mirrorHash: candidate.mirrorHash,
          converterId: doc.converterId ?? undefined,
          converterVersion: doc.converterVersion ?? undefined,
        },
        record: projectRecordEvidenceMetadata(doc),
      };
      let scoredResult = baseResult;
      if (auxiliaryRankingActive) {
        const candidateKey = `${candidate.mirrorHash}:${candidate.seq}:${candidate.documentId ?? ""}`;
        const auxiliaryBaseScore =
          auxiliaryBaseScores.get(candidateKey) ?? candidate.blendedScore;
        const composedBeforeRerank =
          preRerankAdjustedCandidates.has(candidateKey);
        const scoringBaseScore =
          rerankResult.reranked && !composedBeforeRerank
            ? candidate.blendedScore
            : auxiliaryBaseScore;
        const scored = scoreContentTypeBoost(
          scoringBaseScore,
          doc.contentType ?? undefined,
          doc.contentTypeSource,
          doc.relPath,
          doc.collection,
          contentTypeRules,
          options.projectAffinity,
          { kind: "hybrid_blended", score: scoringBaseScore }
        );
        scoredResult = attachAuxiliaryScoreMetadata(
          baseResult,
          scored,
          rerankResult.reranked && composedBeforeRerank
            ? candidate.blendedScore
            : scored.projectAffinity.finalScore,
          hasProjectAffinity(options.projectAffinity)
        );
      }
      if (scoredResult.score < minScore) continue;
      const attached = attachSearchResultPlannerMetadata(scoredResult, {
        retrievalRank: candidateIndex + 1,
        mirrorHash: candidate.mirrorHash,
        seq: snippetChunk.seq,
        ...(auxiliaryRankingActive && snippetChunk.seq !== candidate.seq
          ? { retrievalSeq: candidate.seq }
          : {}),
        sources: [...candidate.sources].sort(),
        graphExpanded: candidate.sources.includes("graph"),
        startLine: snippetChunk.startLine,
        endLine: snippetChunk.endLine,
        passageHash: "",
      });
      deferredChunkTextByResult.set(attached, snippetChunk.text);
      results.push(attached);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Sort, slice, hydrate deferred --full content and passage hashes
  // ─────────────────────────────────────────────────────────────────────────
  const dedupedResults =
    options.full && auxiliaryRankingActive
      ? dedupeFullResultsByDocid(results)
      : results;

  if (recencySort) {
    const recencyTs = new Map<SearchResult, number>();
    for (const r of dedupedResults) {
      recencyTs.set(
        r,
        resolveRecencyTimestamp(r.source.documentDate, r.source.modifiedAt)
      );
    }
    dedupedResults.sort((a, b) => {
      const aTs = recencyTs.get(a) ?? 0;
      const bTs = recencyTs.get(b) ?? 0;
      if (aTs !== bTs) {
        return bTs - aTs;
      }
      return b.score - a.score;
    });
  } else if (auxiliaryRankingActive && !rerankResult.reranked) {
    sortByFinalScoreStable(dedupedResults);
  }

  const finalResults = dedupedResults.slice(0, limit);
  if (options.full && finalResults.length > 0) {
    const fullHashes = [
      ...new Set(
        finalResults
          .map((r) => r.conversion?.mirrorHash)
          .filter((hash): hash is string => Boolean(hash))
      ),
    ];
    if (fullHashes.length > 0) {
      let fullContentByHash: Map<string, string> | undefined;
      const contentBatch = await hydration.getContentBatch(fullHashes);
      if (contentBatch.ok) {
        fullContentByHash = contentBatch.value;
      } else {
        // Recover per hash on batch error so healthy results retain full content.
        const recovered = new Map<string, string>();
        const individual = await Promise.all(
          fullHashes.map(async (hash) => ({
            hash,
            res: await hydration.getContent(hash),
          }))
        );
        for (const { hash, res } of individual) {
          if (res.ok && res.value) {
            recovered.set(hash, res.value);
          }
        }
        fullContentByHash = recovered;
      }
      for (const result of finalResults) {
        const hash = result.conversion?.mirrorHash;
        const fullContent = hash ? fullContentByHash.get(hash) : undefined;
        if (fullContent) {
          result.snippet = fullContent;
          result.snippetRange = undefined;
        }
      }
    }
  }
  for (const [index, result] of finalResults.entries()) {
    assertInferenceActive();
    const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
    if (metadata) {
      metadata.retrievalRank = index + 1;
      if (!metadata.passageHash) {
        const text = deferredChunkTextByResult.get(result);
        if (text !== undefined) {
          metadata.passageHash = new Bun.CryptoHasher("sha256")
            .update(text)
            .digest("hex");
        }
      }
    }
  }

  timings.assemblyMs = performance.now() - assemblyStartedAt;
  timings.totalMs = performance.now() - runStartedAt;
  explainLines.push(explainTimings(timings));
  explainLines.push(explainCounters(counters));

  const explainData = options.explain
    ? {
        lines: explainLines,
        results: auxiliaryRankingActive
          ? buildExplainResults(filteredCandidates, docidMap, finalResults)
          : buildExplainResults(filteredCandidates.slice(0, limit), docidMap),
        ...(vecOutcome.vectorRoute
          ? { vectorRoute: vecOutcome.vectorRoute }
          : {}),
      }
    : undefined;
  await attachSearchResultContexts(store, finalResults);
  await attachSupersession(store, finalResults);
  const finalHashes = [
    ...new Set(
      finalResults
        .map((r) => r.conversion?.mirrorHash)
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];
  const lineageResult = await attachSearchResultEgressLineage(
    store,
    finalResults,
    {
      ownershipHashes: finalHashes,
      ownershipDocuments:
        options.collection === undefined && options.collections === undefined
          ? documents
          : undefined,
      collections: collectionsResult.ok ? collectionsResult.value : undefined,
    }
  );
  if (!lineageResult.ok) {
    return err("QUERY_FAILED", lineageResult.error.message);
  }

  const output: SearchResults = {
    results: finalResults,
    meta: {
      query,
      mode: vectorsUsed ? "hybrid" : "bm25_only",
      expanded: expansion !== null,
      reranked: rerankResult.reranked,
      vectorsUsed,
      totalResults: finalResults.length,
      intent: options.intent,
      exclude: options.exclude,
      collection: options.collection,
      collections: options.collections,
      lang: options.lang,
      since: temporalRange.since,
      until: temporalRange.until,
      categories: options.categories,
      author: options.author,
      ...(options.filter
        ? { warnings: await typedMetadataWarnings(store, query, options) }
        : {}),
      candidateLimit,
      graphExpansion: {
        enabled: graphExpansion.meta.enabled,
        seedCount: graphExpansion.meta.seedCount,
        candidateCount: graphExpansion.meta.candidateCount,
        maxCandidates: graphExpansion.meta.maxCandidates,
        edgeConfidence: graphExpansion.meta.edgeConfidence,
        fallbackReasons: graphExpansion.meta.fallbackReasons,
      },
      queryLanguage,
      queryModes: queryModeSummary,
      explain: explainData,
      trace: diagnoseTrace,
    },
  };
  if (vectorNotice)
    output.meta.warnings = [
      ...(output.meta.warnings ?? []),
      { code: VECTOR_RUNTIME_INCOMPATIBLE, message: vectorNotice },
    ];
  const fallbackCodes = [...new Set(counters.fallbackEvents)].sort();
  const capabilityOutcomes = [
    { capability: "lexical_search", status: "used" as const },
    vectorAvailable
      ? !vectorsUsed
        ? {
            capability: "semantic_search",
            status: "failed" as const,
            reasonCode: fallbackCodes.includes("vector_embed_error")
              ? "vector_embed_error"
              : vectorNotice
                ? VECTOR_RUNTIME_INCOMPATIBLE
                : "vector_search_error",
          }
        : { capability: "semantic_search", status: "used" as const }
      : {
          capability: "semantic_search",
          status: "unavailable" as const,
          reasonCode: "vector_unavailable",
        },
    expansion !== null
      ? { capability: "query_expansion", status: "used" as const }
      : {
          capability: "query_expansion",
          status:
            expansionStatus === "attempted"
              ? ("failed" as const)
              : ("unavailable" as const),
          reasonCode:
            expansionStatus === "attempted"
              ? "expansion_error"
              : expansionStatus === "skipped_strong"
                ? "expansion_skipped_strong"
                : "expansion_disabled",
        },
    rerankResult.reranked
      ? { capability: "reranking", status: "used" as const }
      : {
          capability: "reranking",
          status:
            rerankResult.fallbackReason === "error"
              ? ("failed" as const)
              : ("unavailable" as const),
          reasonCode:
            rerankResult.fallbackReason === "error"
              ? "rerank_error"
              : "rerank_disabled",
        },
    graphExpansion.meta.enabled
      ? { capability: "graph_expansion", status: "used" as const }
      : {
          capability: "graph_expansion",
          status: "unavailable" as const,
          reasonCode:
            graphExpansion.meta.fallbackReasons[0] ?? "graph_disabled",
        },
  ];
  attachSearchResultsTraceMetadata(output, {
    capabilityOutcomes,
    fallbackCodes,
    ...(vecOutcome.vectorRoute ? { vectorRoute: vecOutcome.vectorRoute } : {}),
  });
  const traceResult = await options.traceSession?.recordRetrieval(
    output,
    timings.totalMs
  );
  if (traceResult && !traceResult.ok) {
    return err(
      "QUERY_FAILED",
      `Trace recording failed: ${traceResult.error.message}`,
      traceResult.error.cause
    );
  }
  return ok(output);
}

function dedupeFullResultsByDocid(results: SearchResult[]): SearchResult[] {
  const bestByDocid = new Map<string, SearchResult>();
  for (const result of results) {
    assertInferenceActive();
    const existing = bestByDocid.get(result.docid);
    if (!existing || result.score > existing.score) {
      bestByDocid.set(result.docid, result);
    }
  }
  return [...bestByDocid.values()];
}
