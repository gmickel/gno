/**
 * BM25 search pipeline.
 * Wraps StorePort.searchFts() to produce SearchResults.
 *
 * @module src/pipeline/search
 */

import type { ChunkRow, FtsResult, StorePort } from '../store/types';
import { err, ok } from '../store/types';
import type {
  SearchOptions,
  SearchResult,
  SearchResultSource,
  SearchResults,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Score Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize BM25 score to 0-1 range.
 * BM25 scores are unbounded; we use tanh(raw/10) for smooth 0-1 mapping.
 * Score of 10 maps to ~0.76, 20 to ~0.96, 30 to ~0.995.
 */
function normalizeBm25Score(raw: number): number {
  return Math.tanh(raw / 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Building
// ─────────────────────────────────────────────────────────────────────────────

/** Build SearchResult from FtsResult and related data */
function buildSearchResult(
  fts: FtsResult,
  chunk: ChunkRow | null,
  collectionPath?: string
): SearchResult {
  const source: SearchResultSource = {
    relPath: fts.relPath ?? '',
    mime: 'text/markdown', // Default for mirror content
    ext: '.md',
  };

  // Add absPath if we have collection path
  if (collectionPath && fts.relPath) {
    source.absPath = `${collectionPath}/${fts.relPath}`;
  }

  return {
    docid: fts.docid ?? '',
    score: normalizeBm25Score(fts.score),
    uri: fts.uri ?? '',
    title: fts.title,
    snippet: fts.snippet ?? chunk?.text ?? '',
    snippetLanguage: chunk?.language ?? undefined,
    snippetRange: chunk
      ? { startLine: chunk.startLine, endLine: chunk.endLine }
      : undefined,
    source,
    conversion: fts.mirrorHash ? { mirrorHash: fts.mirrorHash } : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute BM25 search and return structured results.
 */
export async function searchBm25(
  store: StorePort,
  query: string,
  options: SearchOptions = {}
): Promise<
  ReturnType<typeof ok<SearchResults>> | ReturnType<typeof err<SearchResults>>
> {
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;

  // Run FTS search
  const ftsResult = await store.searchFts(query, {
    limit,
    collection: options.collection,
    language: options.lang,
    snippet: !options.full,
  });

  if (!ftsResult.ok) {
    return err('QUERY_FAILED', ftsResult.error.message, ftsResult.error.cause);
  }

  // Get collection paths for absPath resolution
  const collectionsResult = await store.getCollections();
  const collectionPaths = new Map<string, string>();
  if (collectionsResult.ok) {
    for (const c of collectionsResult.value) {
      collectionPaths.set(c.name, c.path);
    }
  }

  // Build results
  const results: SearchResult[] = [];

  for (const fts of ftsResult.value) {
    // Apply minScore filter after normalization
    const normalizedScore = normalizeBm25Score(fts.score);
    if (normalizedScore < minScore) {
      continue;
    }

    // Get chunk for snippetRange if we have mirrorHash+seq
    let chunk: ChunkRow | null = null;
    if (fts.mirrorHash) {
      const chunksResult = await store.getChunks(fts.mirrorHash);
      if (chunksResult.ok) {
        chunk = chunksResult.value.find((c) => c.seq === fts.seq) ?? null;
      }
    }

    const collectionPath = fts.collection
      ? collectionPaths.get(fts.collection)
      : undefined;

    results.push(buildSearchResult(fts, chunk, collectionPath));
  }

  return ok({
    results,
    meta: {
      query,
      mode: 'bm25',
      totalResults: results.length,
      collection: options.collection,
      lang: options.lang,
    },
  });
}
