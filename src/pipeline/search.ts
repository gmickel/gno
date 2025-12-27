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
 * Normalize BM25 scores to 0-1 range using min-max scaling.
 * FTS5 bm25() returns negative scores where smaller (more negative) = better match.
 * After normalization: 1 = best match, 0 = worst match in result set.
 */
function normalizeBm25Scores(results: SearchResult[]): void {
  if (results.length === 0) {
    return;
  }

  // Raw scores: smaller (more negative) is better
  const scores = results.map((r) => r.score);
  const best = Math.min(...scores); // Most negative = best
  const worst = Math.max(...scores); // Least negative = worst
  const range = worst - best;

  // If all scores equal, assign 1.0 to all
  if (range === 0) {
    for (const r of results) {
      r.score = 1;
    }
    return;
  }

  // Map: best -> 1, worst -> 0 (clamp for floating point safety)
  for (const r of results) {
    r.score = Math.max(0, Math.min(1, (worst - r.score) / range));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Building
// ─────────────────────────────────────────────────────────────────────────────

type BuildResultContext = {
  fts: FtsResult;
  chunk: ChunkRow | null;
  collectionPath?: string;
  options?: SearchOptions;
  fullContent?: string;
};

/** Build SearchResult from FtsResult and related data */
function buildSearchResult(ctx: BuildResultContext): SearchResult {
  const { fts, chunk, collectionPath, options, fullContent } = ctx;
  const source: SearchResultSource = {
    relPath: fts.relPath ?? '',
    mime: 'text/markdown', // Default for mirror content
    ext: '.md',
  };

  // Add absPath if we have collection path
  if (collectionPath && fts.relPath) {
    source.absPath = `${collectionPath}/${fts.relPath}`;
  }

  // Determine snippet content and range
  let snippet: string;
  let snippetRange: { startLine: number; endLine: number } | undefined;

  if (options?.full && fullContent) {
    // --full: use full content, no range (full doc)
    snippet = fullContent;
    snippetRange = undefined;
  } else if (options?.lineNumbers && chunk) {
    // --line-numbers: use raw chunk text (not FTS snippet with markers)
    snippet = chunk.text;
    snippetRange = { startLine: chunk.startLine, endLine: chunk.endLine };
  } else {
    // Default: use FTS snippet or chunk text
    snippet = fts.snippet ?? chunk?.text ?? '';
    snippetRange = chunk
      ? { startLine: chunk.startLine, endLine: chunk.endLine }
      : undefined;
  }

  return {
    docid: fts.docid ?? '',
    score: fts.score, // Raw score, normalized later as batch
    uri: fts.uri ?? '',
    title: fts.title,
    snippet,
    snippetLanguage: chunk?.language ?? undefined,
    snippetRange,
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
  // Disable FTS snippet when --full or --line-numbers (we use raw text instead)
  const ftsResult = await store.searchFts(query, {
    limit,
    collection: options.collection,
    language: options.lang,
    snippet: !(options.full || options.lineNumbers),
  });

  if (!ftsResult.ok) {
    // Adapter returns INVALID_INPUT for FTS syntax errors, pass through
    const { code, message, cause } = ftsResult.error;
    if (code === 'INVALID_INPUT') {
      return err('INVALID_INPUT', `Invalid search query: ${message}`);
    }
    return err('QUERY_FAILED', message, cause);
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

  // TODO: Refactor to use store.getChunksBatch() for N+1 elimination
  // (deferred - FTS JOIN already handles main query efficiently)
  const chunkCache = new Map<string, ChunkRow[]>();

  // For --full, track best score per docid to de-dupe
  const bestByDocid = new Map<
    string,
    { fts: FtsResult; chunk: ChunkRow | null; score: number }
  >();

  for (const fts of ftsResult.value) {
    // Get chunk for snippetRange if we have mirrorHash+seq (cached)
    let chunk: ChunkRow | null = null;
    if (fts.mirrorHash) {
      let chunks = chunkCache.get(fts.mirrorHash);
      if (!chunks) {
        const chunksResult = await store.getChunks(fts.mirrorHash);
        if (chunksResult.ok) {
          chunks = chunksResult.value;
          chunkCache.set(fts.mirrorHash, chunks);
        }
      }
      if (chunks) {
        chunk = chunks.find((c) => c.seq === fts.seq) ?? null;
      }
    }

    // For --full, de-dupe by docid (keep best scoring chunk per doc)
    // Raw BM25: smaller (more negative) is better
    if (options.full) {
      const docid = fts.docid ?? '';
      const existing = bestByDocid.get(docid);
      if (!existing || fts.score < existing.score) {
        bestByDocid.set(docid, { fts, chunk, score: fts.score });
      }
      continue;
    }

    const collectionPath = fts.collection
      ? collectionPaths.get(fts.collection)
      : undefined;

    results.push(buildSearchResult({ fts, chunk, collectionPath, options }));
  }

  // For --full, fetch full content and build results
  if (options.full) {
    for (const { fts, chunk } of bestByDocid.values()) {
      let fullContent: string | undefined;
      if (fts.mirrorHash) {
        const contentResult = await store.getContent(fts.mirrorHash);
        if (contentResult.ok && contentResult.value) {
          fullContent = contentResult.value;
        }
      }
      const collectionPath = fts.collection
        ? collectionPaths.get(fts.collection)
        : undefined;
      results.push(
        buildSearchResult({ fts, chunk, collectionPath, options, fullContent })
      );
    }
  }

  // Normalize scores to 0-1 range (batch min-max)
  normalizeBm25Scores(results);

  // Apply minScore filter after normalization
  const filteredResults =
    minScore > 0 ? results.filter((r) => r.score >= minScore) : results;

  return ok({
    results: filteredResults,
    meta: {
      query,
      mode: 'bm25',
      totalResults: filteredResults.length,
      collection: options.collection,
      lang: options.lang,
    },
  });
}
