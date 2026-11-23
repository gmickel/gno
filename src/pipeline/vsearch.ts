/**
 * Vector search pipeline.
 * Wraps VectorIndexPort.searchNearest() to produce SearchResults.
 *
 * @module src/pipeline/vsearch
 */

import type { Config } from "../config/types";
import type { EmbeddingPort } from "../llm/types";
import type { DocumentRow, StorePort } from "../store/types";
import type { VectorIndexPort, VectorRouteInfo } from "../store/vector/types";
import type { SearchOptions, SearchResult, SearchResults } from "./types";

import { normalizeContentTypes } from "../config/content-types";
import { projectRecordEvidenceMetadata } from "../core/record-metadata";
import { normalizeMetadataPredicate } from "../core/typed-metadata";
import {
  assertInferenceActive,
  assertInferenceResult,
  withInferenceScope,
} from "../llm/inference-scope";
import { getContentBatch } from "../store/content-batch";
import { err, ok } from "../store/types";
import {
  resolveVectorSearchIdentity,
  vectorSearchUnavailableMessage,
} from "../store/vector/variant-search";
import { createChunkLookup } from "./chunk-lookup";
import {
  applyContentTypeBoost,
  hasAuxiliaryRanking,
  scoreContentTypeBoost,
  sortByFinalScoreStable,
} from "./content-type-boost";
import { formatQueryForEmbedding } from "./contextual";
import { attachSearchResultEgressLineage } from "./egress-lineage";
import {
  compileExcludeTerms,
  matchesExcludedChunks,
  matchesExcludedText,
} from "./exclude";
import { typedMetadataWarnings, typedMetadataFilterReason } from "./filters";
import { extractSteeringTerms, selectBestChunkForSteering } from "./intent";
import { hasProjectAffinity } from "./project-affinity";
import { detectQueryLanguage } from "./query-language";
import {
  attachSearchResultContexts,
  attachSupersession,
} from "./result-context";
import { cleanDisplaySnippet } from "./snippet";
import {
  compileTemporalRange,
  resolveRecencyTimestamp,
  isWithinTemporalRange,
  resolveTemporalRange,
  shouldSortByRecency,
  type TemporalRange,
} from "./temporal";
import {
  attachSearchResultPlannerMetadata,
  attachSearchResultsTraceMetadata,
} from "./trace-metadata";
import { SEARCH_RESULT_PLANNER_METADATA } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Score Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize cosine distance to 0-1 similarity score.
 * Cosine distance: 0 = identical, 2 = opposite.
 * Similarity = 1 - (distance / 2)
 */
function normalizeVectorScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector Search Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface VectorSearchDeps {
  store: StorePort;
  vectorIndex: VectorIndexPort;
  embedPort: EmbeddingPort;
  config: Config;
}

function vectorUnavailableMessage(vectorIndex: VectorIndexPort): string {
  const reason = vectorIndex.loadError
    ? ` Reason: ${vectorIndex.loadError}`
    : "";
  const guidance = vectorIndex.guidance
    ? ` ${vectorIndex.guidance}`
    : " Run: gno doctor";
  return `Vector search unavailable.${reason}${guidance}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Function (with pre-computed embedding)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute vector search with pre-computed embedding.
 * Use this to avoid double-embedding when caller already has the query vector.
 */
// oxlint-disable-next-line max-lines-per-function -- search pipeline with expansion, reranking, scoring
export async function searchVectorWithEmbedding(
  deps: VectorSearchDeps,
  query: string,
  queryEmbedding: Float32Array,
  options: SearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  if (options.filter !== undefined)
    options = {
      ...options,
      filter: normalizeMetadataPredicate(options.filter),
    };
  return withInferenceScope(options, () =>
    searchVectorWithEmbeddingOwned(deps, query, queryEmbedding, options)
  );
}

async function searchVectorWithEmbeddingOwned(
  deps: VectorSearchDeps,
  query: string,
  queryEmbedding: Float32Array,
  options: SearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  const traceStartedAt = options.traceSession ? performance.now() : 0;
  const { store, vectorIndex } = deps;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;
  const contentTypeRules =
    options.contentTypeRules ??
    normalizeContentTypes(deps.config.contentTypes ?? []).rules;
  const auxiliaryRankingActive = hasAuxiliaryRanking(
    options.projectAffinity,
    contentTypeRules
  );
  const projectAffinityActive = hasProjectAffinity(options.projectAffinity);
  const recencySort = shouldSortByRecency(query);
  const retrievalLimit =
    recencySort || projectAffinityActive ? limit * 3 : limit;
  const temporalRange = resolveTemporalRange(
    query,
    options.since,
    options.until
  );

  // Detect query language for metadata (DOES NOT affect retrieval filtering)
  const queryLanguage = options.lang ?? detectQueryLanguage(query).bcp47;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err("VEC_SEARCH_UNAVAILABLE", vectorUnavailableMessage(vectorIndex));
  }

  let embeddingIdentity;
  try {
    const partition = await resolveVectorSearchIdentity(
      deps.embedPort,
      vectorIndex
    );
    if (partition.unavailable)
      return err(
        "VEC_SEARCH_UNAVAILABLE",
        vectorSearchUnavailableMessage(partition.unavailable)
      );
    embeddingIdentity = partition.identity;
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
  // Search nearest neighbors
  let vectorRoute: VectorRouteInfo | undefined;
  const searchResult = await vectorIndex.searchNearest(
    queryEmbedding,
    retrievalLimit,
    {
      embeddingIdentity,
      eligibility: {
        excludeMetadata: true,
        semanticMetadata: true,
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
        language: options.lang,
      },
      minScore: projectAffinityActive ? undefined : minScore,
      allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
      coarseVectorSearch:
        options.coarseVectorSearch ?? deps.config?.coarseVectorSearch,
      exact: options.exactVectorSearch,
      onRoute: (info) => {
        vectorRoute = info;
      },
    }
  );

  if (!searchResult.ok) {
    return err("QUERY_FAILED", searchResult.error.message);
  }

  const vecResults = searchResult.value;
  const uniqueHashes = [...new Set(vecResults.map((v) => v.mirrorHash))];

  // Get collection paths for absPath resolution
  const collectionsResult = await store.getCollections();
  const collectionPaths = new Map<string, string>();
  if (collectionsResult.ok) {
    for (const c of collectionsResult.value) {
      assertInferenceActive();
      collectionPaths.set(c.name, c.path);
    }
  }

  // Cache docs to avoid N+1 queries (filtered by collection and tags)
  const { documents: docsByMirrorHash, ownershipDocuments } =
    await buildDocumentMap(store, {
      collection: options.collection,
      collections: options.collections,
      relPathPrefix: options.retrievalScope?.relPathPrefix,
      tagsAll: options.tagsAll,
      tagsAny: options.tagsAny,
      since: temporalRange.since,
      until: temporalRange.until,
      categories: options.categories,
      author: options.author,
      filter: options.filter,
      mirrorHashes: uniqueHashes,
    });

  // Exact sequences suffice unless selection needs whole-document evidence.
  const chunksMapResult =
    store.getChunksBySequenceBatch &&
    !options.intent &&
    !options.exclude?.length
      ? await store.getChunksBySequenceBatch(
          vecResults.map(({ mirrorHash, seq }) => ({ mirrorHash, seq }))
        )
      : await store.getChunksBatch(uniqueHashes);
  if (!chunksMapResult.ok) {
    return err("QUERY_FAILED", chunksMapResult.error.message);
  }
  const chunksMap = chunksMapResult.value;
  const getChunk = createChunkLookup(chunksMap);

  // Build search results
  const results: SearchResult[] = [];
  const deferredChunkTextByResult = new WeakMap<SearchResult, string>();
  const excludeTermsLower = compileExcludeTerms(options.exclude);
  const excludedMirrorCache = excludeTermsLower
    ? new Map<string, boolean>()
    : undefined;
  const queryTerms = options.intent ? extractSteeringTerms(query) : undefined;
  const intentTerms = options.intent
    ? extractSteeringTerms(options.intent)
    : undefined;

  // For --full, track best score per docid to de-dupe
  const bestByDocid = new Map<
    string,
    {
      doc: DocumentInfo;
      chunk: ChunkInfo;
      rankingScore: number;
      rawDistance: number;
      score: number;
    }
  >();

  for (const vec of vecResults) {
    assertInferenceActive();
    const baseScore = normalizeVectorScore(vec.distance);
    if (!projectAffinityActive && baseScore < minScore) {
      continue;
    }

    // Get chunk via O(1) lookup
    const rawChunk = getChunk(vec.mirrorHash, vec.seq);
    const chunk = options.intent
      ? (selectBestChunkForSteering(
          (chunksMap.get(vec.mirrorHash) ?? []).filter(
            (chunk) => !options.lang || chunk.language === options.lang
          ),
          query,
          options.intent,
          {
            preferredSeq: rawChunk?.seq ?? vec.seq,
            intentWeight: 0.3,
            queryTerms,
            intentTerms,
          }
        ) ?? rawChunk)
      : rawChunk;
    if (!chunk) {
      continue;
    }

    // STRICT --lang filter: require exact match (excludes null/undefined)
    if (options.lang && chunk.language !== options.lang) {
      continue;
    }

    // Get document (cached)
    const matchingDocs = docsByMirrorHash
      .get(vec.mirrorHash)
      ?.filter(
        (doc) =>
          vec.documentIds === undefined || vec.documentIds.includes(doc.id)
      );
    if (!matchingDocs || matchingDocs.length === 0) {
      continue;
    }
    const docs =
      auxiliaryRankingActive || vec.documentIds !== undefined
        ? matchingDocs
        : [matchingDocs.at(-1)!];
    let chunksExcluded = false;
    if (excludeTermsLower) {
      const cached = excludedMirrorCache!.get(vec.mirrorHash);
      if (cached !== undefined) {
        chunksExcluded = cached;
      } else {
        chunksExcluded = matchesExcludedChunks(
          chunksMap.get(vec.mirrorHash) ?? [],
          excludeTermsLower,
          true
        );
        excludedMirrorCache!.set(vec.mirrorHash, chunksExcluded);
      }
      if (chunksExcluded) continue;
    }
    for (const doc of docs) {
      assertInferenceActive();
      const sourceRelPath = doc.recordSourcePath ?? doc.relPath;
      if (
        excludeTermsLower &&
        matchesExcludedText(
          [
            doc.title ?? "",
            sourceRelPath,
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

      // For --full, avoid throwaway snippet cleaning / SearchResult construction;
      // compute only the final score needed for dedupe/filtering/ranking.
      if (options.full) {
        const rankingScore = auxiliaryRankingActive
          ? scoreContentTypeBoost(
              baseScore,
              doc.contentType ?? undefined,
              doc.contentTypeSource,
              sourceRelPath,
              doc.collection,
              contentTypeRules,
              options.projectAffinity,
              { kind: "vector_distance", score: vec.distance }
            ).projectAffinity.finalScore
          : baseScore;
        if (rankingScore < minScore) continue;
        const existing = bestByDocid.get(doc.docid);
        if (!existing || rankingScore > existing.rankingScore) {
          bestByDocid.set(doc.docid, {
            doc,
            chunk: {
              text: chunk.text,
              language: chunk.language,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              seq: chunk.seq,
            },
            rankingScore,
            rawDistance: vec.distance,
            score: baseScore,
          });
        }
        continue;
      }

      const collectionPath = collectionPaths.get(doc.collection);
      const cleanedSnippet = cleanDisplaySnippet(chunk.text, chunk.text);
      const snippetStartLine = chunk.startLine + cleanedSnippet.startLineOffset;
      const baseResult: SearchResult = {
        docid: doc.docid,
        score: baseScore,
        uri: doc.uri,
        title: doc.title ?? undefined,
        contentType: doc.contentType ?? undefined,
        categories: doc.categories ?? undefined,
        line: snippetStartLine,
        snippet: cleanedSnippet.text,
        snippetLanguage: chunk.language ?? undefined,
        snippetRange: {
          startLine: snippetStartLine,
          endLine: chunk.endLine,
        },
        source: {
          relPath: sourceRelPath,
          absPath: collectionPath
            ? `${collectionPath}/${sourceRelPath}`
            : undefined,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
          modifiedAt: doc.sourceMtime,
          documentDate: doc.frontmatterDate ?? undefined,
          sizeBytes: doc.sourceSize,
          sourceHash: doc.sourceHash,
        },
        conversion: doc.mirrorHash
          ? {
              mirrorHash: doc.mirrorHash,
              converterId: doc.converterId ?? undefined,
              converterVersion: doc.converterVersion ?? undefined,
            }
          : undefined,
        record: projectRecordEvidenceMetadata(doc),
      };
      const scoredResult = auxiliaryRankingActive
        ? applyContentTypeBoost(
            baseResult,
            doc.collection,
            contentTypeRules,
            options.projectAffinity,
            doc.contentTypeSource,
            { kind: "vector_distance", score: vec.distance }
          )
        : baseResult;
      if (scoredResult.score < minScore) continue;

      const attached = attachSearchResultPlannerMetadata(scoredResult, {
        retrievalRank: 0,
        mirrorHash: vec.mirrorHash,
        seq: chunk.seq,
        sources: ["vector"],
        graphExpanded: false,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        passageHash: "",
      });
      deferredChunkTextByResult.set(attached, chunk.text);
      results.push(attached);
    }
  }

  let finalResults: SearchResult[];
  // For --full, sort and slice BEFORE fetching full content via getContentBatch
  if (options.full) {
    const entries = [...bestByDocid.values()];
    if (recencySort) {
      const recencyTs = new Map<(typeof entries)[number], number>();
      for (const entry of entries) {
        recencyTs.set(
          entry,
          resolveRecencyTimestamp(
            entry.doc.frontmatterDate,
            entry.doc.sourceMtime
          )
        );
      }
      entries.sort((a, b) => {
        const aTs = recencyTs.get(a) ?? 0;
        const bTs = recencyTs.get(b) ?? 0;
        if (aTs !== bTs) return bTs - aTs;
        return b.rankingScore - a.rankingScore;
      });
    } else if (auxiliaryRankingActive) {
      const originalRank = new Map(
        entries.map((entry, idx) => [entry, idx] as const)
      );
      entries.sort(
        (left, right) =>
          right.rankingScore - left.rankingScore ||
          (originalRank.get(left) ?? 0) - (originalRank.get(right) ?? 0)
      );
    }
    const survivingEntries = entries.slice(0, limit);
    const fullContentResult = await getContentBatch(
      store,
      survivingEntries
        .map(({ doc }) => doc.mirrorHash)
        .filter((mirrorHash): mirrorHash is string => Boolean(mirrorHash))
    );
    if (!fullContentResult.ok) {
      return err("QUERY_FAILED", fullContentResult.error.message);
    }
    const fullContentByHash = fullContentResult.value;

    finalResults = [];
    for (const { doc, chunk, rawDistance, score } of survivingEntries) {
      assertInferenceActive();
      const fullContent = doc.mirrorHash
        ? fullContentByHash.get(doc.mirrorHash)
        : undefined;

      const collectionPath = collectionPaths.get(doc.collection);
      const sourceRelPath = doc.recordSourcePath ?? doc.relPath;
      const cleanedChunk = fullContent
        ? undefined
        : cleanDisplaySnippet(chunk.text, chunk.text);
      const snippetStartLine = cleanedChunk
        ? chunk.startLine + cleanedChunk.startLineOffset
        : chunk.startLine;

      const baseResult: SearchResult = {
        docid: doc.docid,
        score,
        uri: doc.uri,
        title: doc.title ?? undefined,
        contentType: doc.contentType ?? undefined,
        categories: doc.categories ?? undefined,
        line: snippetStartLine,
        snippet: fullContent ?? cleanedChunk?.text ?? chunk.text,
        snippetLanguage: chunk.language ?? undefined,
        // --full: no snippetRange (full doc content)
        snippetRange: fullContent
          ? undefined
          : { startLine: snippetStartLine, endLine: chunk.endLine },
        source: {
          relPath: sourceRelPath,
          absPath: collectionPath
            ? `${collectionPath}/${sourceRelPath}`
            : undefined,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
          modifiedAt: doc.sourceMtime,
          documentDate: doc.frontmatterDate ?? undefined,
          sizeBytes: doc.sourceSize,
          sourceHash: doc.sourceHash,
        },
        conversion: doc.mirrorHash
          ? {
              mirrorHash: doc.mirrorHash,
              converterId: doc.converterId ?? undefined,
              converterVersion: doc.converterVersion ?? undefined,
            }
          : undefined,
        record: projectRecordEvidenceMetadata(doc),
      };
      const result = auxiliaryRankingActive
        ? applyContentTypeBoost(
            baseResult,
            doc.collection,
            contentTypeRules,
            options.projectAffinity,
            doc.contentTypeSource,
            { kind: "vector_distance", score: rawDistance }
          )
        : baseResult;
      finalResults.push(
        doc.mirrorHash
          ? attachSearchResultPlannerMetadata(result, {
              retrievalRank: 0,
              mirrorHash: doc.mirrorHash,
              seq: chunk.seq,
              sources: ["vector"],
              graphExpanded: false,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              passageHash: new Bun.CryptoHasher("sha256")
                .update(chunk.text)
                .digest("hex"),
            })
          : result
      );
    }
  } else {
    if (recencySort) {
      const recencyTs = new Map<SearchResult, number>();
      for (const r of results) {
        recencyTs.set(
          r,
          resolveRecencyTimestamp(r.source.documentDate, r.source.modifiedAt)
        );
      }
      results.sort((a, b) => {
        const aTs = recencyTs.get(a) ?? 0;
        const bTs = recencyTs.get(b) ?? 0;
        if (aTs !== bTs) {
          return bTs - aTs;
        }
        return b.score - a.score;
      });
    } else if (auxiliaryRankingActive) {
      sortByFinalScoreStable(results);
    }
    finalResults = results.slice(0, limit);
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
      ownershipDocuments,
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
      mode: "vector",
      vectorsUsed: true,
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
      queryLanguage,
    },
  };
  if (vectorRoute) {
    attachSearchResultsTraceMetadata(output, {
      capabilityOutcomes: [{ capability: "semantic_search", status: "used" }],
      fallbackCodes: [],
      vectorRoute,
    });
  }
  const traceResult = await options.traceSession?.recordRetrieval(
    output,
    performance.now() - traceStartedAt
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

/**
 * Execute vector search and return structured results.
 * Embeds the query internally - use searchVectorWithEmbedding if you already have the embedding.
 */
export async function searchVector(
  deps: VectorSearchDeps,
  query: string,
  options: SearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  if (options.filter !== undefined)
    options = {
      ...options,
      filter: normalizeMetadataPredicate(options.filter),
    };
  return withInferenceScope(options, () =>
    searchVectorOwned(deps, query, options)
  );
}

async function searchVectorOwned(
  deps: VectorSearchDeps,
  query: string,
  options: SearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  const { vectorIndex, embedPort } = deps;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err("VEC_SEARCH_UNAVAILABLE", vectorUnavailableMessage(vectorIndex));
  }

  // Embed query with contextual formatting
  const embedResult = await embedPort.embed(
    formatQueryForEmbedding(query, embedPort.modelUri)
  );
  assertInferenceResult(embedResult);
  if (!embedResult.ok) {
    return err(
      "QUERY_FAILED",
      `Failed to embed query: ${embedResult.error.message}`
    );
  }

  const queryEmbedding = new Float32Array(embedResult.value);

  return searchVectorWithEmbedding(deps, query, queryEmbedding, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Types
// ─────────────────────────────────────────────────────────────────────────────

interface ChunkInfo {
  text: string;
  language: string | null;
  startLine: number;
  endLine: number;
  seq: number;
}

interface DocumentInfo {
  id: number;
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  author: string | null;
  contentType: string | null;
  contentTypeSource: string | null;
  categories: string[] | null;
  sourceHash: string;
  sourceMime: string;
  sourceExt: string;
  sourceMtime: string;
  frontmatterDate?: string | null;
  sourceSize: number;
  mirrorHash: string | null;
  converterId: string | null;
  converterVersion: string | null;
  recordKey: DocumentRow["recordKey"];
  recordSourcePath: DocumentRow["recordSourcePath"];
  recordSourceLocator: DocumentRow["recordSourceLocator"];
  recordMetadata: DocumentRow["recordMetadata"];
  recordAnchors: DocumentRow["recordAnchors"];
  recordAdapterFingerprint: DocumentRow["recordAdapterFingerprint"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build document map by mirrorHash
// ─────────────────────────────────────────────────────────────────────────────

interface DocumentMapOptions {
  collection?: string;
  collections?: string[];
  relPathPrefix?: string;
  tagsAll?: string[];
  tagsAny?: string[];
  since?: string;
  until?: string;
  categories?: string[];
  author?: string;
  filter?: SearchOptions["filter"];
  mirrorHashes?: string[];
}

function matchesCategoryFilter(
  doc: { contentType?: string | null; categories?: string[] | null },
  allowedCategories?: Set<string>
): boolean {
  if (!allowedCategories || allowedCategories.size === 0) {
    return true;
  }
  if (doc.contentType && allowedCategories.has(doc.contentType.toLowerCase())) {
    return true;
  }
  return (doc.categories ?? []).some((c) =>
    allowedCategories.has(c.toLowerCase())
  );
}

async function buildDocumentMap(
  store: StorePort,
  options: DocumentMapOptions = {}
): Promise<{
  documents: Map<string, DocumentInfo[]>;
  ownershipDocuments: DocumentRow[];
}> {
  const documents = new Map<string, DocumentInfo[]>();

  if (options.mirrorHashes && options.mirrorHashes.length === 0) {
    return { documents, ownershipDocuments: [] };
  }

  const docs = options.mirrorHashes
    ? await store.getDocumentsByMirrorHashes(options.mirrorHashes, {
        activeOnly: true,
      })
    : await store.listDocuments(options.collection);
  if (!docs.ok) {
    return { documents, ownershipDocuments: [] };
  }

  // Filter docs with mirrorHash.
  // listDocuments path still needs explicit active filter.
  const ownershipDocuments = options.mirrorHashes
    ? docs.value.filter((d) => d.mirrorHash)
    : docs.value.filter((d) => d.mirrorHash && d.active);
  const activeDocs = ownershipDocuments.filter(
    (document) =>
      (!options.collection || document.collection === options.collection) &&
      (options.collections === undefined ||
        options.collections.includes(document.collection))
  );
  const temporalRange: TemporalRange = compileTemporalRange({
    since: options.since,
    until: options.until,
  });
  const allowedCategories = options.categories?.length
    ? new Set(options.categories.map((c) => c.toLowerCase()))
    : undefined;
  const authorLower = options.author ? options.author.toLowerCase() : undefined;

  // Apply tag filters if specified (batch fetch to avoid N+1)
  const needsTagFilter = options.tagsAll?.length || options.tagsAny?.length;
  let allowedDocIds: Set<number> | null = null;

  if (needsTagFilter && activeDocs.length > 0) {
    const docIds = activeDocs.map((d) => d.id);
    const tagsResult = await store.getTagsBatch(docIds);

    if (!tagsResult.ok) return { documents, ownershipDocuments };
    if (tagsResult.ok) {
      allowedDocIds = new Set<number>();
      const tagsByDocId = tagsResult.value;

      for (const doc of activeDocs) {
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

        allowedDocIds.add(doc.id);
      }
    }
  }

  for (const doc of activeDocs) {
    assertInferenceActive();
    if (typedMetadataFilterReason(doc, options.filter)) continue;
    const sourceRelPath = doc.recordSourcePath ?? doc.relPath;
    if (
      options.relPathPrefix !== undefined &&
      sourceRelPath !== options.relPathPrefix &&
      !sourceRelPath.startsWith(`${options.relPathPrefix}/`)
    ) {
      continue;
    }
    if (!isWithinTemporalRange(doc.sourceMtime, temporalRange)) {
      continue;
    }
    if (!matchesCategoryFilter(doc, allowedCategories)) {
      continue;
    }
    if (authorLower && !doc.author?.toLowerCase().includes(authorLower)) {
      continue;
    }

    // Skip if tag filter excluded this doc
    if (allowedDocIds !== null && !allowedDocIds.has(doc.id)) {
      continue;
    }

    const documentInfo: DocumentInfo = {
      id: doc.id,
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      collection: doc.collection,
      relPath: doc.relPath,
      author: doc.author ?? null,
      contentType: doc.contentType ?? null,
      contentTypeSource: doc.contentTypeSource ?? null,
      categories: doc.categories ?? null,
      sourceHash: doc.sourceHash,
      sourceMime: doc.sourceMime,
      sourceExt: doc.sourceExt,
      sourceMtime: doc.sourceMtime,
      frontmatterDate: doc.frontmatterDate,
      sourceSize: doc.sourceSize,
      mirrorHash: doc.mirrorHash,
      converterId: doc.converterId,
      converterVersion: doc.converterVersion,
      recordKey: doc.recordKey,
      recordSourcePath: doc.recordSourcePath,
      recordSourceLocator: doc.recordSourceLocator,
      recordMetadata: doc.recordMetadata,
      recordAnchors: doc.recordAnchors,
      recordAdapterFingerprint: doc.recordAdapterFingerprint,
    };
    const matchingDocuments = documents.get(doc.mirrorHash!) ?? [];
    matchingDocuments.push(documentInfo);
    documents.set(doc.mirrorHash!, matchingDocuments);
  }

  return { documents, ownershipDocuments };
}
