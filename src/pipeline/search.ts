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

import { getContentBatch } from "../store/content-batch";
import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import {
  applyContentTypeBoost,
  hasAuxiliaryRanking,
  sortByFinalScoreStable,
} from "./content-type-boost";
import { matchesExcludedChunks, matchesExcludedText } from "./exclude";
import { selectBestChunkForSteering } from "./intent";
import { hasProjectAffinity } from "./project-affinity";
import { detectQueryLanguage } from "./query-language";
import { attachSearchResultContexts } from "./result-context";
import {
  resolveRecencyTimestamp,
  resolveTemporalRange,
  shouldSortByRecency,
} from "./temporal";
import { attachSearchResultPlannerMetadata } from "./trace-metadata";
import { SEARCH_RESULT_PLANNER_METADATA } from "./types";

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
    documentDate: fts.frontmatterDate,
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

  const result: SearchResult = {
    docid: fts.docid ?? "",
    score: fts.score, // Raw score, normalized later as batch
    uri: fts.uri ?? "",
    title: fts.title,
    contentType: fts.contentType,
    categories: fts.categories,
    line: chunk?.startLine,
    snippet,
    snippetLanguage: chunk?.language ?? undefined,
    snippetRange,
    source,
    conversion: fts.mirrorHash ? { mirrorHash: fts.mirrorHash } : undefined,
  };
  if (!(chunk && fts.mirrorHash)) return result;
  return attachSearchResultPlannerMetadata(result, {
    retrievalRank: 0,
    mirrorHash: fts.mirrorHash,
    seq: chunk.seq,
    sources: ["bm25"],
    graphExpanded: false,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    passageHash: new Bun.CryptoHasher("sha256")
      .update(chunk.text)
      .digest("hex"),
  });
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
  const traceStartedAt = options.traceSession ? performance.now() : 0;
  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0;
  const auxiliaryRankingActive = hasAuxiliaryRanking(
    options.projectAffinity,
    options.contentTypeRules
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
  const detection = detectQueryLanguage(query);
  const queryLanguage = options.lang ?? detection.bcp47;

  // Run FTS search
  // Disable FTS snippet when --full or --line-numbers (we use raw text instead)
  const ftsResult = await store.searchFts(query, {
    limit: retrievalLimit,
    collection: options.collection,
    relPathPrefix: options.retrievalScope?.relPathPrefix,
    language: options.lang,
    snippet: !(options.full || options.lineNumbers),
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: temporalRange.since,
    until: temporalRange.until,
    categories: options.categories,
    author: options.author,
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
  const scoringByResult = new WeakMap<
    SearchResult,
    { collection: string; rawScore: number }
  >();

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
  const fullAffinityEntries: {
    fts: FtsResult;
    chunk: ChunkRow | null;
    score: number;
  }[] = [];

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
    const rawChunk = fts.mirrorHash
      ? (getChunk(fts.mirrorHash, fts.seq) ?? null)
      : null;
    const chunk =
      options.intent && fts.mirrorHash
        ? (selectBestChunkForSteering(
            chunksMapResult.ok
              ? (chunksMapResult.value.get(fts.mirrorHash) ?? [])
              : [],
            query,
            options.intent,
            {
              preferredSeq: rawChunk?.seq ?? fts.seq,
              intentWeight: 0.3,
            }
          ) ?? rawChunk)
        : rawChunk;

    const excluded =
      matchesExcludedText(
        [fts.title ?? "", fts.relPath ?? "", fts.snippet ?? ""],
        options.exclude
      ) ||
      matchesExcludedChunks(
        chunksMapResult.ok && fts.mirrorHash
          ? (chunksMapResult.value.get(fts.mirrorHash) ?? [])
          : [],
        options.exclude
      );
    if (excluded) {
      continue;
    }

    // For --full, de-dupe by docid (keep best scoring chunk per doc)
    // Raw BM25: smaller (more negative) is better
    if (options.full) {
      if (auxiliaryRankingActive) {
        fullAffinityEntries.push({ fts, chunk, score: fts.score });
        continue;
      }
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
    const result = buildSearchResult({ fts, chunk, collectionPath, options });
    if (fts.collection) {
      scoringByResult.set(result, {
        collection: fts.collection,
        rawScore: fts.score,
      });
    }
    results.push(result);
  }

  // For --full, fetch full content and build results
  if (options.full) {
    // Sort by raw BM25 score (smaller = better) before building results
    const sortedEntries = (
      auxiliaryRankingActive ? fullAffinityEntries : [...bestByDocid.values()]
    ).sort((a, b) => a.score - b.score);
    const fullContentResult = await getContentBatch(
      store,
      sortedEntries
        .map(({ fts }) => fts.mirrorHash)
        .filter((mirrorHash): mirrorHash is string => Boolean(mirrorHash))
    );
    if (!fullContentResult.ok) {
      return err("QUERY_FAILED", fullContentResult.error.message);
    }
    const fullContentByHash = fullContentResult.value;

    for (const { fts, chunk } of sortedEntries) {
      const fullContent = fts.mirrorHash
        ? fullContentByHash.get(fts.mirrorHash)
        : undefined;
      const collectionPath = fts.collection
        ? collectionPaths.get(fts.collection)
        : undefined;
      const result = buildSearchResult({
        fts,
        chunk,
        collectionPath,
        options,
        fullContent,
      });
      if (fts.collection) {
        scoringByResult.set(result, {
          collection: fts.collection,
          rawScore: fts.score,
        });
      }
      results.push(result);
    }
  }

  // Normalize scores to 0-1 range (batch min-max)
  normalizeBm25Scores(results);

  if (auxiliaryRankingActive) {
    for (const result of results) {
      const scoring = scoringByResult.get(result);
      if (scoring) {
        applyContentTypeBoost(
          result,
          scoring.collection,
          options.contentTypeRules,
          options.projectAffinity,
          { kind: "bm25", score: scoring.rawScore }
        );
      }
    }
  }

  const dedupedResults =
    options.full && auxiliaryRankingActive
      ? dedupeFullResultsByDocid(results)
      : results;

  // Apply minScore filter after normalization
  const filteredResults =
    minScore > 0
      ? dedupedResults.filter((r) => r.score >= minScore)
      : dedupedResults;

  if (recencySort) {
    filteredResults.sort((a, b) => {
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
  } else if (auxiliaryRankingActive) {
    sortByFinalScoreStable(filteredResults);
  }

  const finalResults = filteredResults.slice(0, limit);
  for (const [index, result] of finalResults.entries()) {
    const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
    if (metadata) metadata.retrievalRank = index + 1;
  }
  await attachSearchResultContexts(store, finalResults);

  const output: SearchResults = {
    results: finalResults,
    meta: {
      query,
      mode: "bm25",
      totalResults: Math.min(filteredResults.length, limit),
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
  };
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

function dedupeFullResultsByDocid(results: SearchResult[]): SearchResult[] {
  const bestByDocid = new Map<string, SearchResult>();
  for (const result of results) {
    const existing = bestByDocid.get(result.docid);
    if (!existing || result.score > existing.score) {
      bestByDocid.set(result.docid, result);
    }
  }
  return [...bestByDocid.values()];
}
