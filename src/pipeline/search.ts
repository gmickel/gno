/**
 * BM25 search pipeline.
 * Wraps StorePort.searchFts() to produce SearchResults.
 *
 * @module src/pipeline/search
 */

import { join as pathJoin } from "node:path"; // No Bun path utils equivalent

import type { ChunkRow, FtsResult, StorePort } from "../store/types";
import type {
  SearchOptions,
  SearchResult,
  SearchResultSource,
  SearchResults,
} from "./types";

import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import { detectQueryLanguage } from "./query-language";

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

interface BuildResultContext {
  fts: FtsResult;
  chunk: ChunkRow | null;
  collectionPath?: string;
  options?: SearchOptions;
  fullContent?: string;
}

/** Build SearchResult from FtsResult and related data */
function buildSearchResult(ctx: BuildResultContext): SearchResult {
  const { fts, chunk, collectionPath, options, fullContent } = ctx;
  const source: SearchResultSource = {
    relPath: fts.relPath ?? "",
    // Use actual source metadata with fallback to markdown defaults
    mime: fts.sourceMime ?? "text/markdown",
    ext: fts.sourceExt ?? ".md",
    modifiedAt: fts.sourceMtime,
    sizeBytes: fts.sourceSize,
    sourceHash: fts.sourceHash,
  };

  // Add absPath if we have collection path (cross-platform safe)
  if (collectionPath && fts.relPath) {
    source.absPath = pathJoin(collectionPath, fts.relPath);
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
    snippet = fts.snippet ?? chunk?.text ?? "";
    snippetRange = chunk
      ? { startLine: chunk.startLine, endLine: chunk.endLine }
      : undefined;
  }

  return {
    docid: fts.docid ?? "",
    score: fts.score, // Raw score, normalized later as batch
    uri: fts.uri ?? "",
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
// oxlint-disable-next-line max-lines-per-function -- BM25 search with pagination, filtering, explain
export async function searchBm25(
  store: StorePort,
  query: string,
  options: SearchOptions = {}
): Promise<ReturnType<typeof ok<SearchResults>>> {
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;

  // Detect query language for metadata (DOES NOT affect retrieval filtering)
  const detection = detectQueryLanguage(query);
  const queryLanguage = options.lang ?? detection.bcp47;

  // Run FTS search
  // Disable FTS snippet when --full or --line-numbers (we use raw text instead)
  const ftsResult = await store.searchFts(query, {
    limit,
    collection: options.collection,
    language: options.lang,
    snippet: !(options.full || options.lineNumbers),
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
  });

  if (!ftsResult.ok) {
    // Adapter returns INVALID_INPUT for FTS syntax errors, pass through
    const { code, message, cause } = ftsResult.error;
    if (code === "INVALID_INPUT") {
      return err("INVALID_INPUT", `Invalid search query: ${message}`);
    }
    return err("QUERY_FAILED", message, cause);
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

  // Pre-fetch all chunks in one batch query (eliminates N+1)
  const uniqueHashes = [
    ...new Set(
      ftsResult.value.map((f) => f.mirrorHash).filter((h): h is string => !!h)
    ),
  ];
  const chunksMapResult = await store.getChunksBatch(uniqueHashes);
  const getChunk = chunksMapResult.ok
    ? createChunkLookup(chunksMapResult.value)
    : () => undefined;

  // Dedup: multiple docs can share mirror_hash (content-addressed storage)
  // Track seen uri+seq to eliminate duplicate rows from join fan-out
  // Robust key: use uri if present, else fall back to mirrorHash+relPath
  const seenUriSeq = new Set<string>();
  // For --full, track best score per docid to de-dupe
  const bestByDocid = new Map<
    string,
    { fts: FtsResult; chunk: ChunkRow | null; score: number }
  >();

  for (const fts of ftsResult.value) {
    // Dedup by uri+seq - eliminates rows from mirror_hash join fan-out
    // Use robust key to avoid over-dedup if uri is unexpectedly missing
    const uriSeqKey = fts.uri
      ? `${fts.uri}:${fts.seq}`
      : `${fts.mirrorHash ?? ""}:${fts.seq}:${fts.relPath ?? ""}`;
    if (seenUriSeq.has(uriSeqKey)) {
      continue;
    }
    seenUriSeq.add(uriSeqKey);

    // Get chunk via O(1) lookup
    const chunk = fts.mirrorHash
      ? (getChunk(fts.mirrorHash, fts.seq) ?? null)
      : null;

    // For --full, de-dupe by docid (keep best scoring chunk per doc)
    // Raw BM25: smaller (more negative) is better
    if (options.full) {
      const docid = fts.docid ?? "";
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
    // Sort by raw BM25 score (smaller = better) before building results
    const sortedEntries = [...bestByDocid.values()].sort(
      (a, b) => a.score - b.score
    );
    for (const { fts, chunk } of sortedEntries) {
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
      mode: "bm25",
      totalResults: filteredResults.length,
      collection: options.collection,
      lang: options.lang,
      queryLanguage,
    },
  });
}
