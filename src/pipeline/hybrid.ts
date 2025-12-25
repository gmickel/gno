/**
 * Hybrid search orchestrator.
 * Combines BM25, vector search, expansion, fusion, and reranking.
 *
 * @module src/pipeline/hybrid
 */

import type { Config } from '../config/types';
import type { EmbeddingPort, GenerationPort, RerankPort } from '../llm/types';
import type { StorePort } from '../store/types';
import { type err, ok } from '../store/types';
import type { VectorIndexPort } from '../store/vector/types';
import { expandQuery } from './expansion';
import {
  buildExplainResults,
  explainBm25,
  explainExpansion,
  explainFusion,
  explainRerank,
  explainVector,
} from './explain';
import { type RankedInput, rrfFuse, toRankedInput } from './fusion';
import { rerankCandidates } from './rerank';
import type {
  ExpansionResult,
  ExplainLine,
  HybridSearchOptions,
  PipelineConfig,
  SearchResult,
  SearchResults,
} from './types';
import { DEFAULT_PIPELINE_CONFIG } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type HybridSearchDeps = {
  store: StorePort;
  config: Config;
  vectorIndex: VectorIndexPort | null;
  embedPort: EmbeddingPort | null;
  genPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  pipelineConfig?: PipelineConfig;
};

// ─────────────────────────────────────────────────────────────────────────────
// Score Normalization (from search.ts)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeBm25Score(raw: number): number {
  return Math.tanh(raw / 10);
}

function normalizeVectorScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// BM25 Strength Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if BM25 results are strong enough to skip expansion.
 * Uses raw store API to get normalized score.
 */
async function checkBm25Strength(
  store: StorePort,
  query: string,
  options?: { collection?: string; lang?: string }
): Promise<number> {
  const result = await store.searchFts(query, {
    limit: 5,
    collection: options?.collection,
    language: options?.lang,
  });
  if (!result.ok || result.value.length === 0) {
    return 0;
  }
  // Return max normalized score from top results
  return Math.max(...result.value.map((r) => normalizeBm25Score(r.score)));
}

// ─────────────────────────────────────────────────────────────────────────────
// FTS Retrieval (returns ChunkIds)
// ─────────────────────────────────────────────────────────────────────────────

type ChunkId = { mirrorHash: string; seq: number };

async function searchFtsChunks(
  store: StorePort,
  query: string,
  options: { limit: number; collection?: string; lang?: string }
): Promise<ChunkId[]> {
  const result = await store.searchFts(query, {
    limit: options.limit,
    collection: options.collection,
    language: options.lang,
  });
  if (!result.ok) {
    return [];
  }
  return result.value.map((r) => ({
    mirrorHash: r.mirrorHash,
    seq: r.seq,
  }));
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

  const embedResult = await embedPort.embed(query);
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
export async function searchHybrid(
  deps: HybridSearchDeps,
  query: string,
  options: HybridSearchOptions = {}
): Promise<
  ReturnType<typeof ok<SearchResults>> | ReturnType<typeof err<SearchResults>>
> {
  const { store, config, vectorIndex, embedPort, genPort, rerankPort } = deps;
  const pipelineConfig = deps.pipelineConfig ?? DEFAULT_PIPELINE_CONFIG;

  const limit = options.limit ?? 20;
  const explainLines: ExplainLine[] = [];
  let expansion: ExpansionResult | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Check if expansion needed
  // ─────────────────────────────────────────────────────────────────────────
  const shouldExpand = !options.noExpand && genPort !== null;
  let skipExpansionDueToStrength = false;

  if (shouldExpand) {
    const bm25Strength = await checkBm25Strength(store, query, {
      collection: options.collection,
      lang: options.lang,
    });
    skipExpansionDueToStrength =
      bm25Strength >= pipelineConfig.strongBm25Threshold;

    if (!skipExpansionDueToStrength) {
      const expandResult = await expandQuery(genPort, query, {
        lang: options.lang,
        timeout: pipelineConfig.expansionTimeout,
      });
      if (expandResult.ok) {
        expansion = expandResult.value;
      }
    }
  }

  explainLines.push(
    explainExpansion(shouldExpand && !skipExpansionDueToStrength, expansion)
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Parallel retrieval using raw store/vector APIs for correct seq tracking
  // ─────────────────────────────────────────────────────────────────────────
  const rankedInputs: RankedInput[] = [];

  // BM25: original query
  const bm25Chunks = await searchFtsChunks(store, query, {
    limit: limit * 2,
    collection: options.collection,
    lang: options.lang,
  });

  const bm25Count = bm25Chunks.length;
  if (bm25Count > 0) {
    rankedInputs.push(toRankedInput('bm25', bm25Chunks));
  }

  // BM25: lexical variants
  if (expansion?.lexicalQueries) {
    for (const variant of expansion.lexicalQueries) {
      const variantChunks = await searchFtsChunks(store, variant, {
        limit,
        collection: options.collection,
        lang: options.lang,
      });
      if (variantChunks.length > 0) {
        rankedInputs.push(toRankedInput('bm25_variant', variantChunks));
      }
    }
  }

  explainLines.push(explainBm25(bm25Count));

  // Vector search
  let vecCount = 0;
  const vectorAvailable = vectorIndex?.searchAvailable && embedPort !== null;

  if (vectorAvailable && vectorIndex && embedPort) {
    // Original query
    const vecChunks = await searchVectorChunks(vectorIndex, embedPort, query, {
      limit: limit * 2,
    });

    vecCount = vecChunks.length;
    if (vecCount > 0) {
      rankedInputs.push(toRankedInput('vector', vecChunks));
    }

    // Semantic variants
    if (expansion?.vectorQueries) {
      for (const variant of expansion.vectorQueries) {
        const variantChunks = await searchVectorChunks(
          vectorIndex,
          embedPort,
          variant,
          { limit }
        );
        if (variantChunks.length > 0) {
          rankedInputs.push(toRankedInput('vector_variant', variantChunks));
        }
      }
    }

    // HyDE
    if (expansion?.hyde) {
      const hydeChunks = await searchVectorChunks(
        vectorIndex,
        embedPort,
        expansion.hyde,
        { limit }
      );
      if (hydeChunks.length > 0) {
        rankedInputs.push(toRankedInput('hyde', hydeChunks));
      }
    }
  }

  explainLines.push(explainVector(vecCount, vectorAvailable ?? false));

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
    options.noRerank ? null : rerankPort,
    store,
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
  // 5. Build final results (optimized: batch lookups, no per-candidate queries)
  // ─────────────────────────────────────────────────────────────────────────

  // Fetch documents and collections ONCE
  const docsResult = await store.listDocuments(options.collection);
  const collectionsResult = await store.getCollections();

  if (!docsResult.ok) {
    return ok({
      results: [],
      meta: {
        query,
        mode: vectorAvailable ? 'hybrid' : 'bm25_only',
        expanded: expansion !== null,
        reranked: rerankResult.reranked,
        vectorsUsed: vectorAvailable ?? false,
        totalResults: 0,
        collection: options.collection,
        lang: options.lang,
      },
    });
  }

  // Build lookup maps
  const docByMirrorHash = new Map<string, (typeof docsResult.value)[number]>();
  for (const doc of docsResult.value) {
    if (doc.active && doc.mirrorHash) {
      docByMirrorHash.set(doc.mirrorHash, doc);
    }
  }

  const collectionPaths = new Map<string, string>();
  if (collectionsResult.ok) {
    for (const c of collectionsResult.value) {
      collectionPaths.set(c.name, c.path);
    }
  }

  // Cache chunks by mirrorHash to avoid repeated fetches
  const chunksCache = new Map<
    string,
    Awaited<ReturnType<typeof store.getChunks>>
  >();

  const results: SearchResult[] = [];
  const docidMap = new Map<string, string>();

  for (const candidate of rerankResult.candidates.slice(0, limit)) {
    // Get or fetch chunks for this mirrorHash
    let chunksResult = chunksCache.get(candidate.mirrorHash);
    if (!chunksResult) {
      chunksResult = await store.getChunks(candidate.mirrorHash);
      chunksCache.set(candidate.mirrorHash, chunksResult);
    }

    if (!chunksResult.ok) continue;

    const chunk = chunksResult.value.find((c) => c.seq === candidate.seq);
    if (!chunk) continue;

    // Find document from pre-fetched map
    const doc = docByMirrorHash.get(candidate.mirrorHash);
    if (!doc) continue;

    docidMap.set(`${candidate.mirrorHash}:${candidate.seq}`, doc.docid);

    const collectionPath = collectionPaths.get(doc.collection);

    results.push({
      docid: doc.docid,
      score: candidate.blendedScore,
      uri: doc.uri,
      title: doc.title ?? undefined,
      snippet: chunk.text,
      snippetLanguage: chunk.language ?? undefined,
      snippetRange: {
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      },
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
          rerankResult.candidates.slice(0, limit),
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
      mode: vectorAvailable ? 'hybrid' : 'bm25_only',
      expanded: expansion !== null,
      reranked: rerankResult.reranked,
      vectorsUsed: vectorAvailable ?? false,
      totalResults: results.length,
      collection: options.collection,
      lang: options.lang,
      explain: explainData,
    },
  });
}
