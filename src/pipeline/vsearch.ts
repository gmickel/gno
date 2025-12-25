/**
 * Vector search pipeline.
 * Wraps VectorIndexPort.searchNearest() to produce SearchResults.
 *
 * @module src/pipeline/vsearch
 */

import type { Config } from '../config/types';
import type { EmbeddingPort } from '../llm/types';
import type { StorePort } from '../store/types';
import { err, ok } from '../store/types';
import type { VectorIndexPort } from '../store/vector/types';
import type { SearchOptions, SearchResult, SearchResults } from './types';

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

export type VectorSearchDeps = {
  store: StorePort;
  vectorIndex: VectorIndexPort;
  embedPort: EmbeddingPort;
  config: Config;
};

// ─────────────────────────────────────────────────────────────────────────────
// Search Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute vector search and return structured results.
 */
export async function searchVector(
  deps: VectorSearchDeps,
  query: string,
  options: SearchOptions = {}
): Promise<
  ReturnType<typeof ok<SearchResults>> | ReturnType<typeof err<SearchResults>>
> {
  const { store, vectorIndex, embedPort } = deps;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;

  // Check if vector search is available
  if (!vectorIndex.searchAvailable) {
    return err(
      'VEC_SEARCH_UNAVAILABLE',
      'Vector search requires sqlite-vec. Run: gno embed'
    );
  }

  // Embed query
  const embedResult = await embedPort.embed(query);
  if (!embedResult.ok) {
    return err(
      'QUERY_FAILED',
      `Failed to embed query: ${embedResult.error.message}`
    );
  }

  const queryEmbedding = new Float32Array(embedResult.value);

  // Search nearest neighbors
  const searchResult = await vectorIndex.searchNearest(queryEmbedding, limit, {
    minScore,
  });

  if (!searchResult.ok) {
    return err('QUERY_FAILED', searchResult.error.message);
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

  // Build search results - need to get document + chunk info
  const results: SearchResult[] = [];

  for (const vec of vecResults) {
    const score = normalizeVectorScore(vec.distance);
    if (score < minScore) {
      continue;
    }

    // Get chunk text for snippet
    const chunksResult = await store.getChunks(vec.mirrorHash);
    if (!chunksResult.ok) {
      continue;
    }
    const chunk = chunksResult.value.find((c) => c.seq === vec.seq);
    if (!chunk) {
      continue;
    }

    // Get document for metadata
    const doc = await findDocumentByMirrorHash(
      store,
      vec.mirrorHash,
      options.collection
    );
    if (!doc) {
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

  return ok({
    results,
    meta: {
      query,
      mode: 'vector',
      vectorsUsed: true,
      totalResults: results.length,
      collection: options.collection,
      lang: options.lang,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Find document by mirror hash
// ─────────────────────────────────────────────────────────────────────────────

type DocumentInfo = {
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
};

async function findDocumentByMirrorHash(
  store: StorePort,
  mirrorHash: string,
  collectionFilter?: string
): Promise<DocumentInfo | null> {
  // List all documents and find one with matching mirrorHash
  // This is not optimal but StorePort doesn't have getDocumentByMirrorHash
  const docs = await store.listDocuments(collectionFilter);
  if (!docs.ok) {
    return null;
  }

  const doc = docs.value.find((d) => d.mirrorHash === mirrorHash && d.active);
  if (!doc) {
    return null;
  }

  return {
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
  };
}
