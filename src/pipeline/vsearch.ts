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

import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import { formatQueryForEmbedding } from "./contextual";
import { detectQueryLanguage } from "./query-language";

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

  // Detect query language for metadata (DOES NOT affect retrieval filtering)
  const detection = detectQueryLanguage(query);
  const queryLanguage = options.lang ?? detection.bcp47;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err(
      "VEC_SEARCH_UNAVAILABLE",
      "Vector search requires sqlite-vec. Run: gno embed"
    );
  }

  // Search nearest neighbors
  const searchResult = await vectorIndex.searchNearest(queryEmbedding, limit, {
    minScore,
  });

  if (!searchResult.ok) {
    return err("QUERY_FAILED", searchResult.error.message);
  }

  const vecResults = searchResult.value;

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
  });

  // Pre-fetch all chunks in one batch query (eliminates N+1)
  const uniqueHashes = [...new Set(vecResults.map((v) => v.mirrorHash))];
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
    const chunk = getChunk(vec.mirrorHash, vec.seq);
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
    for (const { doc, chunk, score } of bestByDocid.values()) {
      let fullContent: string | undefined;
      if (doc.mirrorHash) {
        const contentResult = await store.getContent(doc.mirrorHash);
        if (contentResult.ok && contentResult.value) {
          fullContent = contentResult.value;
        }
      }

      const collectionPath = collectionPaths.get(doc.collection);

      results.push({
        docid: doc.docid,
        score,
        uri: doc.uri,
        title: doc.title ?? undefined,
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

  return ok({
    results,
    meta: {
      query,
      mode: "vector",
      vectorsUsed: true,
      totalResults: results.length,
      collection: options.collection,
      lang: options.lang,
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
    return err(
      "VEC_SEARCH_UNAVAILABLE",
      "Vector search requires sqlite-vec. Run: gno embed"
    );
  }

  // Embed query with contextual formatting
  const embedResult = await embedPort.embed(formatQueryForEmbedding(query));
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
  sourceHash: string;
  sourceMime: string;
  sourceExt: string;
  sourceMtime: string;
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
}

async function buildDocumentMap(
  store: StorePort,
  options: DocumentMapOptions = {}
): Promise<Map<string, DocumentInfo>> {
  const result = new Map<string, DocumentInfo>();

  const docs = await store.listDocuments(options.collection);
  if (!docs.ok) {
    return result;
  }

  // Filter active docs with mirrorHash
  const activeDocs = docs.value.filter((d) => d.mirrorHash && d.active);

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
      sourceHash: doc.sourceHash,
      sourceMime: doc.sourceMime,
      sourceExt: doc.sourceExt,
      sourceMtime: doc.sourceMtime,
      sourceSize: doc.sourceSize,
      mirrorHash: doc.mirrorHash,
      converterId: doc.converterId,
      converterVersion: doc.converterVersion,
    });
  }

  return result;
}
