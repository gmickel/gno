/**
 * Vector search pipeline.
 * Wraps VectorIndexPort.searchNearest() to produce SearchResults.
 *
 * @module src/pipeline/vsearch
 */

import type { Config } from "../config/types";
import type { EmbeddingPort } from "../llm/types";
import type { StorePort } from "../store/types";
import type { VectorIndexPort } from "../store/vector/types";
import type { SearchOptions, SearchResult, SearchResults } from "./types";

import { getContentBatch } from "../store/content-batch";
import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import { formatQueryForEmbedding } from "./contextual";
import { matchesExcludedChunks, matchesExcludedText } from "./exclude";
import { selectBestChunkForSteering } from "./intent";
import { detectQueryLanguage } from "./query-language";
import {
  resolveRecencyTimestamp,
  isWithinTemporalRange,
  resolveTemporalRange,
  shouldSortByRecency,
  type TemporalRange,
} from "./temporal";

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
  const { store, vectorIndex } = deps;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;
  const recencySort = shouldSortByRecency(query);
  const retrievalLimit = recencySort ? limit * 3 : limit;
  const temporalRange = resolveTemporalRange(
    query,
    options.since,
    options.until
  );

  // Detect query language for metadata (DOES NOT affect retrieval filtering)
  const detection = detectQueryLanguage(query);
  const queryLanguage = options.lang ?? detection.bcp47;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err("VEC_SEARCH_UNAVAILABLE", vectorUnavailableMessage(vectorIndex));
  }

  // Search nearest neighbors
  const searchResult = await vectorIndex.searchNearest(
    queryEmbedding,
    retrievalLimit,
    {
      minScore,
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
      collectionPaths.set(c.name, c.path);
    }
  }

  // Cache docs to avoid N+1 queries (filtered by collection and tags)
  const docByMirrorHash = await buildDocumentMap(store, {
    collection: options.collection,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: temporalRange.since,
    until: temporalRange.until,
    categories: options.categories,
    author: options.author,
    mirrorHashes: uniqueHashes,
  });

  // Pre-fetch all chunks in one batch query (eliminates N+1)
  const chunksMapResult = await store.getChunksBatch(uniqueHashes);
  if (!chunksMapResult.ok) {
    return err("QUERY_FAILED", chunksMapResult.error.message);
  }
  const chunksMap = chunksMapResult.value;
  const getChunk = createChunkLookup(chunksMap);

  // Build search results
  const results: SearchResult[] = [];

  // For --full, track best score per docid to de-dupe
  const bestByDocid = new Map<
    string,
    { doc: DocumentInfo; chunk: ChunkInfo; score: number }
  >();

  for (const vec of vecResults) {
    const score = normalizeVectorScore(vec.distance);
    if (score < minScore) {
      continue;
    }

    // Get chunk via O(1) lookup
    const rawChunk = getChunk(vec.mirrorHash, vec.seq);
    const chunk = options.intent
      ? (selectBestChunkForSteering(
          chunksMap.get(vec.mirrorHash) ?? [],
          query,
          options.intent,
          {
            preferredSeq: rawChunk?.seq ?? vec.seq,
            intentWeight: 0.3,
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
    const doc = docByMirrorHash.get(vec.mirrorHash);
    if (!doc) {
      continue;
    }

    const excluded =
      matchesExcludedText(
        [
          doc.title ?? "",
          doc.relPath,
          doc.author ?? "",
          doc.contentType ?? "",
          ...(doc.categories ?? []),
        ],
        options.exclude
      ) ||
      matchesExcludedChunks(
        chunksMap.get(vec.mirrorHash) ?? [],
        options.exclude
      );
    if (excluded) {
      continue;
    }

    // For --full, de-dupe by docid (keep best scoring chunk per doc)
    if (options.full) {
      const existing = bestByDocid.get(doc.docid);
      if (!existing || score > existing.score) {
        bestByDocid.set(doc.docid, {
          doc,
          chunk: {
            text: chunk.text,
            language: chunk.language,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          },
          score,
        });
      }
      continue;
    }

    const collectionPath = collectionPaths.get(doc.collection);

    results.push({
      docid: doc.docid,
      score,
      uri: doc.uri,
      title: doc.title ?? undefined,
      line: chunk.startLine,
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
    });
  }

  // For --full, fetch full content and build results
  if (options.full) {
    const fullContentResult = await getContentBatch(
      store,
      [...bestByDocid.values()]
        .map(({ doc }) => doc.mirrorHash)
        .filter((mirrorHash): mirrorHash is string => Boolean(mirrorHash))
    );
    if (!fullContentResult.ok) {
      return err("QUERY_FAILED", fullContentResult.error.message);
    }
    const fullContentByHash = fullContentResult.value;

    for (const { doc, chunk, score } of bestByDocid.values()) {
      const fullContent = doc.mirrorHash
        ? fullContentByHash.get(doc.mirrorHash)
        : undefined;

      const collectionPath = collectionPaths.get(doc.collection);

      results.push({
        docid: doc.docid,
        score,
        uri: doc.uri,
        title: doc.title ?? undefined,
        line: chunk.startLine,
        snippet: fullContent ?? chunk.text,
        snippetLanguage: chunk.language ?? undefined,
        // --full: no snippetRange (full doc content)
        snippetRange: fullContent
          ? undefined
          : { startLine: chunk.startLine, endLine: chunk.endLine },
        source: {
          relPath: doc.relPath,
          absPath: collectionPath
            ? `${collectionPath}/${doc.relPath}`
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
      });
    }
  }

  if (recencySort) {
    results.sort((a, b) => {
      const aTs = resolveRecencyTimestamp(
        a.source.documentDate,
        a.source.modifiedAt
      );
      const bTs = resolveRecencyTimestamp(
        b.source.documentDate,
        b.source.modifiedAt
      );
      if (aTs !== bTs) {
        return bTs - aTs;
      }
      return b.score - a.score;
    });
  }

  const finalResults = results.slice(0, limit);

  return ok({
    results: finalResults,
    meta: {
      query,
      mode: "vector",
      vectorsUsed: true,
      totalResults: finalResults.length,
      intent: options.intent,
      exclude: options.exclude,
      collection: options.collection,
      lang: options.lang,
      since: temporalRange.since,
      until: temporalRange.until,
      categories: options.categories,
      author: options.author,
      queryLanguage,
    },
  });
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
  const { vectorIndex, embedPort } = deps;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err("VEC_SEARCH_UNAVAILABLE", vectorUnavailableMessage(vectorIndex));
  }

  // Embed query with contextual formatting
  const embedResult = await embedPort.embed(
    formatQueryForEmbedding(query, embedPort.modelUri)
  );
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
}

interface DocumentInfo {
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  author: string | null;
  contentType: string | null;
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build document map by mirrorHash
// ─────────────────────────────────────────────────────────────────────────────

interface DocumentMapOptions {
  collection?: string;
  tagsAll?: string[];
  tagsAny?: string[];
  since?: string;
  until?: string;
  categories?: string[];
  author?: string;
  mirrorHashes?: string[];
}

function matchesCategoryFilter(
  doc: { contentType?: string | null; categories?: string[] | null },
  categories?: string[]
): boolean {
  if (!categories || categories.length === 0) {
    return true;
  }
  const allowed = new Set(categories.map((c) => c.toLowerCase()));
  if (doc.contentType && allowed.has(doc.contentType.toLowerCase())) {
    return true;
  }
  return (doc.categories ?? []).some((c) => allowed.has(c.toLowerCase()));
}

async function buildDocumentMap(
  store: StorePort,
  options: DocumentMapOptions = {}
): Promise<Map<string, DocumentInfo>> {
  const result = new Map<string, DocumentInfo>();

  if (options.mirrorHashes && options.mirrorHashes.length === 0) {
    return result;
  }

  const docs = options.mirrorHashes
    ? await store.getDocumentsByMirrorHashes(options.mirrorHashes, {
        collection: options.collection,
        activeOnly: true,
      })
    : await store.listDocuments(options.collection);
  if (!docs.ok) {
    return result;
  }

  // Filter docs with mirrorHash.
  // listDocuments path still needs explicit active filter.
  const activeDocs = options.mirrorHashes
    ? docs.value.filter((d) => d.mirrorHash)
    : docs.value.filter((d) => d.mirrorHash && d.active);
  const temporalRange: TemporalRange = {
    since: options.since,
    until: options.until,
  };

  // Apply tag filters if specified (batch fetch to avoid N+1)
  const needsTagFilter = options.tagsAll?.length || options.tagsAny?.length;
  let allowedDocIds: Set<number> | null = null;

  if (needsTagFilter && activeDocs.length > 0) {
    const docIds = activeDocs.map((d) => d.id);
    const tagsResult = await store.getTagsBatch(docIds);

    if (tagsResult.ok) {
      allowedDocIds = new Set<number>();
      const tagsByDocId = tagsResult.value;

      for (const doc of activeDocs) {
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
    if (!isWithinTemporalRange(doc.sourceMtime, temporalRange)) {
      continue;
    }
    if (!matchesCategoryFilter(doc, options.categories)) {
      continue;
    }
    if (
      options.author &&
      !doc.author?.toLowerCase().includes(options.author.toLowerCase())
    ) {
      continue;
    }

    // Skip if tag filter excluded this doc
    if (allowedDocIds !== null && !allowedDocIds.has(doc.id)) {
      continue;
    }

    result.set(doc.mirrorHash!, {
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      collection: doc.collection,
      relPath: doc.relPath,
      author: doc.author ?? null,
      contentType: doc.contentType ?? null,
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
    });
  }

  return result;
}
