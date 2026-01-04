/**
 * Hybrid search orchestrator.
 * Combines BM25, vector search, expansion, fusion, and reranking.
 *
 * @module src/pipeline/hybrid
 */

import type { Config } from "../config/types";
import type { EmbeddingPort, GenerationPort, RerankPort } from "../llm/types";
import type { StorePort } from "../store/types";
import type { VectorIndexPort } from "../store/vector/types";
import type {
  ExpansionResult,
  ExplainLine,
  HybridSearchOptions,
  PipelineConfig,
  SearchResult,
  SearchResults,
} from "./types";

import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import { formatQueryForEmbedding } from "./contextual";
import { expandQuery } from "./expansion";
import {
  buildExplainResults,
  type ExpansionStatus,
  explainBm25,
  explainExpansion,
  explainFusion,
  explainRerank,
  explainVector,
} from "./explain";
import { type RankedInput, rrfFuse, toRankedInput } from "./fusion";
import { detectQueryLanguage } from "./query-language";
import { rerankCandidates } from "./rerank";
import { DEFAULT_PIPELINE_CONFIG } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface HybridSearchDeps {
  store: StorePort;
  config: Config;
  vectorIndex: VectorIndexPort | null;
  embedPort: EmbeddingPort | null;
  genPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  pipelineConfig?: PipelineConfig;
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
 * Check if BM25 results are strong enough to skip expansion.
 * Returns true if top result is both confident AND clearly separated.
 * This prevents skipping on weak-but-separated results.
 */
async function checkBm25Strength(
  store: StorePort,
  query: string,
  options?: {
    collection?: string;
    lang?: string;
    tagsAll?: string[];
    tagsAny?: string[];
  }
): Promise<boolean> {
  const result = await store.searchFts(query, {
    limit: 5,
    collection: options?.collection,
    language: options?.lang,
    tagsAll: options?.tagsAll,
    tagsAny: options?.tagsAny,
  });

  if (!result.ok || result.value.length === 0) {
    return false;
  }

  // Normalize scores (higher = better)
  const scores = result.value
    .map((r) => normalizeBm25Score(r.score))
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
  mirrorHash: string;
  seq: number;
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
    lang?: string;
    tagsAll?: string[];
    tagsAny?: string[];
  }
): Promise<FtsChunksResult> {
  const result = await store.searchFts(query, {
    limit: options.limit,
    collection: options.collection,
    language: options.lang,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
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
      mirrorHash: r.mirrorHash,
      seq: r.seq,
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
  options: { limit: number; minScore?: number }
): Promise<ChunkId[]> {
  if (!vectorIndex.searchAvailable) {
    return [];
  }

  // Embed query with contextual formatting
  const embedResult = await embedPort.embed(formatQueryForEmbedding(query));
  if (!embedResult.ok) {
    return [];
  }

  const queryEmbedding = new Float32Array(embedResult.value);
  const searchResult = await vectorIndex.searchNearest(
    queryEmbedding,
    options.limit,
    { minScore: options.minScore }
  );

  if (!searchResult.ok) {
    return [];
  }

  return searchResult.value.map((r) => ({
    mirrorHash: r.mirrorHash,
    seq: r.seq,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute hybrid search with full pipeline.
 */
// oxlint-disable-next-line max-lines-per-function -- search orchestration with BM25, vector, fusion, reranking
export async function searchHybrid(
  deps: HybridSearchDeps,
  query: string,
  options: HybridSearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  const { store, vectorIndex, embedPort, genPort, rerankPort } = deps;
  const pipelineConfig = deps.pipelineConfig ?? DEFAULT_PIPELINE_CONFIG;

  const limit = options.limit ?? 20;
  const explainLines: ExplainLine[] = [];
  let expansion: ExpansionResult | null = null;

  // When tag filters are present, increase retrieval limits since vector results
  // are filtered post-retrieval and we need more candidates to fill the limit
  const hasTagFilters = options.tagsAll?.length || options.tagsAny?.length;
  const retrievalMultiplier = hasTagFilters ? 3 : 1;

  // ─────────────────────────────────────────────────────────────────────────
  // 0. Detect query language for PROMPT SELECTION only
  //    CRITICAL: Detection does NOT change retrieval filters - options.lang does
  //    Priority: queryLanguageHint (MCP) > lang (CLI) > detection
  // ─────────────────────────────────────────────────────────────────────────
  const detection = detectQueryLanguage(query);
  // Use explicit hint > lang filter > detected language
  const queryLanguage =
    options.queryLanguageHint ?? options.lang ?? detection.bcp47;

  // Build explain message for language detection
  let langMessage: string;
  if (options.queryLanguageHint) {
    langMessage = `queryLanguage=${queryLanguage} (hint)`;
  } else if (options.lang) {
    langMessage = `queryLanguage=${queryLanguage} (explicit)`;
  } else {
    const confidence = detection.confident ? "" : ", low confidence";
    langMessage = `queryLanguage=${queryLanguage} (detected${confidence})`;
  }
  explainLines.push({ stage: "lang", message: langMessage });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Check if expansion needed
  // ─────────────────────────────────────────────────────────────────────────
  const shouldExpand = !options.noExpand && genPort !== null;
  let expansionStatus: ExpansionStatus = "disabled";

  if (shouldExpand) {
    const hasStrongSignal = await checkBm25Strength(store, query, {
      collection: options.collection,
      lang: options.lang,
      tagsAll: options.tagsAll,
      tagsAny: options.tagsAny,
    });

    if (hasStrongSignal) {
      expansionStatus = "skipped_strong";
    } else {
      expansionStatus = "attempted";
      const expandResult = await expandQuery(genPort, query, {
        // Use queryLanguage for prompt selection, NOT options.lang (retrieval filter)
        lang: queryLanguage,
        timeout: pipelineConfig.expansionTimeout,
      });
      if (expandResult.ok) {
        expansion = expandResult.value;
      }
    }
  }

  explainLines.push(explainExpansion(expansionStatus, expansion));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Parallel retrieval using raw store/vector APIs for correct seq tracking
  // ─────────────────────────────────────────────────────────────────────────
  const rankedInputs: RankedInput[] = [];

  // BM25: original query
  const bm25Result = await searchFtsChunks(store, query, {
    limit: limit * 2,
    collection: options.collection,
    lang: options.lang,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
  });

  // Propagate FTS syntax errors as INVALID_INPUT
  if (!bm25Result.ok && bm25Result.code === "INVALID_INPUT") {
    return err("INVALID_INPUT", `Invalid search query: ${bm25Result.message}`);
  }
  // Other errors: continue with empty BM25 results

  const bm25Chunks = bm25Result.ok ? bm25Result.chunks : [];
  const bm25Count = bm25Chunks.length;
  if (bm25Count > 0) {
    rankedInputs.push(toRankedInput("bm25", bm25Chunks));
  }

  // BM25: lexical variants (syntax errors here are ignored - variants are optional)
  if (expansion?.lexicalQueries) {
    for (const variant of expansion.lexicalQueries) {
      const variantResult = await searchFtsChunks(store, variant, {
        limit,
        collection: options.collection,
        lang: options.lang,
        tagsAll: options.tagsAll,
        tagsAny: options.tagsAny,
      });
      if (variantResult.ok && variantResult.chunks.length > 0) {
        rankedInputs.push(toRankedInput("bm25_variant", variantResult.chunks));
      }
    }
  }

  explainLines.push(explainBm25(bm25Count));

  // Vector search
  let vecCount = 0;
  const vectorAvailable =
    (vectorIndex?.searchAvailable && embedPort !== null) ?? false;

  if (vectorAvailable && vectorIndex && embedPort) {
    // Original query (increase limit when tag filters active since filtering is post-retrieval)
    const vecChunks = await searchVectorChunks(vectorIndex, embedPort, query, {
      limit: limit * 2 * retrievalMultiplier,
    });

    vecCount = vecChunks.length;
    if (vecCount > 0) {
      rankedInputs.push(toRankedInput("vector", vecChunks));
    }

    // Semantic variants
    if (expansion?.vectorQueries) {
      for (const variant of expansion.vectorQueries) {
        const variantChunks = await searchVectorChunks(
          vectorIndex,
          embedPort,
          variant,
          { limit: limit * retrievalMultiplier }
        );
        if (variantChunks.length > 0) {
          rankedInputs.push(toRankedInput("vector_variant", variantChunks));
        }
      }
    }

    // HyDE
    if (expansion?.hyde) {
      const hydeChunks = await searchVectorChunks(
        vectorIndex,
        embedPort,
        expansion.hyde,
        { limit: limit * retrievalMultiplier }
      );
      if (hydeChunks.length > 0) {
        rankedInputs.push(toRankedInput("hyde", hydeChunks));
      }
    }
  }

  explainLines.push(explainVector(vecCount, vectorAvailable));

  // ─────────────────────────────────────────────────────────────────────────
  // 3. RRF Fusion
  // ─────────────────────────────────────────────────────────────────────────
  const fusedCandidates = rrfFuse(rankedInputs, pipelineConfig.rrf);
  explainLines.push(
    explainFusion(pipelineConfig.rrf.k, fusedCandidates.length)
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Reranking
  // ─────────────────────────────────────────────────────────────────────────
  const rerankResult = await rerankCandidates(
    { rerankPort: options.noRerank ? null : rerankPort, store },
    query,
    fusedCandidates,
    { maxCandidates: pipelineConfig.rerankCandidates }
  );

  explainLines.push(
    explainRerank(
      !options.noRerank && rerankPort !== null,
      pipelineConfig.rerankCandidates
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 4b. Apply minScore filter (blendedScore is now normalized to [0,1])
  // ─────────────────────────────────────────────────────────────────────────
  const minScore = options.minScore ?? 0;
  const filteredCandidates =
    minScore > 0
      ? rerankResult.candidates.filter((c) => c.blendedScore >= minScore)
      : rerankResult.candidates;

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Build final results (optimized: batch lookups, no per-candidate queries)
  // ─────────────────────────────────────────────────────────────────────────

  // Collect unique mirrorHashes needed from candidates
  // TODO: For large corpora (100k+ docs), add store.getDocumentsByMirrorHashes
  // batch lookup to avoid loading all documents into memory.
  const neededHashes = new Set(filteredCandidates.map((c) => c.mirrorHash));

  // Fetch documents and collections
  const docsResult = await store.listDocuments(options.collection);
  const collectionsResult = await store.getCollections();

  if (!docsResult.ok) {
    return err("QUERY_FAILED", docsResult.error.message);
  }

  // Build lookup maps - only include docs needed by candidates
  const docByMirrorHash = new Map<string, (typeof docsResult.value)[number]>();

  // Collect doc IDs that need tag filtering
  const needsTagFilter = options.tagsAll?.length || options.tagsAny?.length;
  const docIdsForTagCheck: number[] = [];
  const candidateDocs: (typeof docsResult.value)[number][] = [];

  for (const doc of docsResult.value) {
    if (doc.active && doc.mirrorHash && neededHashes.has(doc.mirrorHash)) {
      if (needsTagFilter) {
        docIdsForTagCheck.push(doc.id);
        candidateDocs.push(doc);
      } else {
        docByMirrorHash.set(doc.mirrorHash, doc);
      }
    }
  }

  // Apply tag filters if needed (batch fetch to avoid N+1)
  if (needsTagFilter && docIdsForTagCheck.length > 0) {
    const tagsResult = await store.getTagsBatch(docIdsForTagCheck);
    if (tagsResult.ok) {
      const tagsByDocId = tagsResult.value;
      for (const doc of candidateDocs) {
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

        if (doc.mirrorHash) {
          docByMirrorHash.set(doc.mirrorHash, doc);
        }
      }
    }
  }

  const collectionPaths = new Map<string, string>();
  if (collectionsResult.ok) {
    for (const c of collectionsResult.value) {
      collectionPaths.set(c.name, c.path);
    }
  }

  // Pre-fetch all chunks in one batch query (eliminates N+1)
  const chunksMapResult = await store.getChunksBatch([...neededHashes]);
  if (!chunksMapResult.ok) {
    return err("QUERY_FAILED", chunksMapResult.error.message);
  }
  const chunksMap = chunksMapResult.value;
  const getChunk = createChunkLookup(chunksMap);

  // Cache full content by mirrorHash for --full mode
  const contentCache = new Map<
    string,
    Awaited<ReturnType<typeof store.getContent>>
  >();

  const results: SearchResult[] = [];
  const docidMap = new Map<string, string>();
  // Track seen docids for --full de-duplication
  const seenDocids = new Set<string>();

  // Iterate until we have enough results (don't slice early - deduping may skip candidates)
  for (const candidate of filteredCandidates) {
    // Stop when we have enough results
    if (results.length >= limit) {
      break;
    }

    // Find document from pre-fetched map
    const doc = docByMirrorHash.get(candidate.mirrorHash);
    if (!doc) {
      continue;
    }

    // For --full mode, de-dupe by docid (keep best scoring candidate per doc)
    if (options.full && seenDocids.has(doc.docid)) {
      continue;
    }

    // Get chunk via O(1) lookup
    // For doc-level FTS (seq=0), fall back to first available chunk if exact lookup fails
    let chunk = getChunk(candidate.mirrorHash, candidate.seq);
    if (!chunk && candidate.seq === 0) {
      // Doc-level FTS uses seq=0 as placeholder - try first chunk
      const docChunks = chunksMap.get(candidate.mirrorHash);
      chunk = docChunks?.[0];
    }
    if (!chunk) {
      continue;
    }

    // STRICT --lang filter: require exact match (excludes null/undefined)
    if (options.lang && chunk.language !== options.lang) {
      continue;
    }

    docidMap.set(`${candidate.mirrorHash}:${candidate.seq}`, doc.docid);

    const collectionPath = collectionPaths.get(doc.collection);

    // For --full mode, fetch full mirror content
    let snippet = chunk.text;
    let snippetRange: { startLine: number; endLine: number } | undefined = {
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    };

    if (options.full) {
      // Get or fetch full content for this mirrorHash
      let contentResult = contentCache.get(candidate.mirrorHash);
      if (!contentResult) {
        contentResult = await store.getContent(candidate.mirrorHash);
        contentCache.set(candidate.mirrorHash, contentResult);
      }

      if (contentResult.ok && contentResult.value) {
        snippet = contentResult.value;
        snippetRange = undefined; // Full content has no range
      }
      // Fallback to chunk text if content unavailable
    }

    seenDocids.add(doc.docid);

    results.push({
      docid: doc.docid,
      score: candidate.blendedScore,
      uri: doc.uri,
      title: doc.title ?? undefined,
      snippet,
      snippetLanguage: chunk.language ?? undefined,
      snippetRange,
      source: {
        relPath: doc.relPath,
        absPath: collectionPath
          ? `${collectionPath}/${doc.relPath}`
          : undefined,
        mime: doc.sourceMime,
        ext: doc.sourceExt,
        modifiedAt: doc.sourceMtime,
        sizeBytes: doc.sourceSize,
        sourceHash: doc.sourceHash,
      },
      conversion: {
        mirrorHash: candidate.mirrorHash,
        converterId: doc.converterId ?? undefined,
        converterVersion: doc.converterVersion ?? undefined,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Build explain data (if requested)
  // ─────────────────────────────────────────────────────────────────────────
  const explainData = options.explain
    ? {
        lines: explainLines,
        results: buildExplainResults(
          filteredCandidates.slice(0, limit),
          docidMap
        ),
      }
    : undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Return results
  // ─────────────────────────────────────────────────────────────────────────
  return ok({
    results,
    meta: {
      query,
      mode: vectorAvailable ? "hybrid" : "bm25_only",
      expanded: expansion !== null,
      reranked: rerankResult.reranked,
      vectorsUsed: vectorAvailable,
      totalResults: results.length,
      collection: options.collection,
      lang: options.lang,
      queryLanguage,
      explain: explainData,
    },
  });
}
