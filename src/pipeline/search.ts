/**
 * BM25 search pipeline.
 * Wraps StorePort.searchFts() to produce SearchResults.
 *
 * @module src/pipeline/search
 */

import { join as pathJoin } from "node:path"; // No Bun path utils equivalent

import type { ChunkRow, FtsResult, StorePort } from "../store/types";
import type { ChunkTermSet, SnippetTerms } from "./query-snippet";
import type {
  SearchOptions,
  SearchResult,
  SearchResultSource,
  SearchResults,
} from "./types";

import { projectRecordEvidenceMetadata } from "../core/record-metadata";
import { normalizeMetadataPredicate } from "../core/typed-metadata";
import { getContentBatch } from "../store/content-batch";
import { err, ok } from "../store/types";
import { createChunkLookup } from "./chunk-lookup";
import {
  applyContentTypeBoost,
  hasAuxiliaryRanking,
  sortByFinalScoreStable,
} from "./content-type-boost";
import { attachSearchResultEgressLineage } from "./egress-lineage";
import {
  compileExcludeTerms,
  matchesExcludedChunks,
  matchesExcludedText,
} from "./exclude";
import { typedMetadataWarnings } from "./filters";
import { extractSteeringTerms, selectBestChunkForSteering } from "./intent";
import { hasProjectAffinity } from "./project-affinity";
import { detectQueryLanguage } from "./query-language";
import {
  chunkTermPresence,
  createSnippetTerms,
  pickSnippetSeq,
  presentTermIds,
  renderChunkSnippet,
  snippetTermWeights,
} from "./query-snippet";
import {
  attachSearchResultContexts,
  attachSupersession,
} from "./result-context";
import { cleanDisplaySnippet } from "./snippet";
import {
  resolveRecencyTimestamp,
  resolveTemporalRange,
  shouldSortByRecency,
} from "./temporal";
import { attachSearchResultPlannerMetadata } from "./trace-metadata";
import { SEARCH_RESULT_PLANNER_METADATA } from "./types";

const passageHash = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

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
  deferPassageHash?: boolean;
}

/** Build SearchResult from FtsResult and related data */
function buildSearchResult(ctx: BuildResultContext): SearchResult {
  const {
    fts,
    chunk,
    collectionPath,
    options,
    fullContent,
    deferPassageHash = false,
  } = ctx;
  const sourceRelPath = fts.recordSourcePath ?? fts.relPath ?? "";
  const source: SearchResultSource = {
    relPath: sourceRelPath,
    // Use actual source metadata with fallback to markdown defaults
    mime: fts.sourceMime ?? "text/markdown",
    ext: fts.sourceExt ?? ".md",
    modifiedAt: fts.sourceMtime,
    documentDate: fts.frontmatterDate,
    sizeBytes: fts.sourceSize,
    sourceHash: fts.sourceHash,
  };

  // Add absPath if we have collection path (cross-platform safe)
  if (collectionPath && sourceRelPath) {
    source.absPath = pathJoin(collectionPath, sourceRelPath);
  }

  // Determine snippet content and range
  let snippet: string;
  let snippetRange: { startLine: number; endLine: number } | undefined;
  let line = chunk?.startLine;

  if (options?.full && fullContent) {
    // --full: use full content, no range (full doc)
    snippet = fullContent;
    snippetRange = undefined;
  } else if (options?.lineNumbers && chunk) {
    // --line-numbers: use raw chunk text (not FTS snippet with markers)
    snippet = chunk.text;
    snippetRange = { startLine: chunk.startLine, endLine: chunk.endLine };
  } else if (chunk) {
    // Default: chunk text until attachChunkSnippets replaces it for the final
    // rows, with leading frontmatter stripped
    const cleaned = cleanDisplaySnippet(chunk.text, chunk.text);
    snippet = cleaned.text;
    line = chunk.startLine + cleaned.startLineOffset;
    snippetRange = { startLine: line, endLine: chunk.endLine };
  } else {
    snippet = "";
    snippetRange = undefined;
  }

  const result: SearchResult = {
    docid: fts.docid ?? "",
    score: fts.score, // Raw score, normalized later as batch
    uri: fts.uri ?? "",
    title: fts.title,
    contentType: fts.contentType,
    categories: fts.categories,
    line,
    snippet,
    snippetLanguage: chunk?.language ?? undefined,
    snippetRange,
    source,
    conversion: fts.mirrorHash ? { mirrorHash: fts.mirrorHash } : undefined,
    record: projectRecordEvidenceMetadata(fts),
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
    passageHash: deferPassageHash ? "" : passageHash(chunk.text),
  });
}

/** Query-word ids present in each chunk of the returned documents. */
async function readChunkTermSets(
  store: StorePort,
  hashes: string[],
  terms: SnippetTerms,
  loadedChunks: Map<string, ChunkRow[]> | undefined
): Promise<{
  termSets: Map<string, ChunkTermSet[]>;
  chunks?: Map<string, ChunkRow[]>;
} | null> {
  const termSets = new Map<string, ChunkTermSet[]>();
  const add = (mirrorHash: string, seq: number, present: boolean[]) => {
    const list = termSets.get(mirrorHash) ?? [];
    list.push({ seq, terms: presentTermIds(present, terms) });
    termSets.set(mirrorHash, list);
  };
  // In-database presence keeps long documents from being loaded whole.
  const presence =
    !loadedChunks && store.getChunkTermPresence
      ? await store.getChunkTermPresence(hashes, terms.prefixes)
      : undefined;
  if (presence?.ok) {
    for (const row of presence.value) add(row.mirrorHash, row.seq, row.present);
    return { termSets };
  }
  let chunks = loadedChunks;
  if (!chunks) {
    const fetched = await store.getChunksBatch(hashes);
    if (!fetched.ok) return null;
    chunks = fetched.value;
  }
  for (const [mirrorHash, list] of chunks)
    for (const chunk of list)
      add(mirrorHash, chunk.seq, chunkTermPresence(chunk.text, terms));
  return { termSets, chunks };
}

/**
 * Default-mode snippets for the returned rows only, built from their stored
 * chunks (FTS5 snippet() re-tokenized every matched document body). Only the
 * chosen chunk of each row is loaded; with an intent, the steered chunk is
 * kept. The snippet, its range and the planner chunk all name that chunk.
 * Updates results in place so hidden ranking metadata stays attached.
 */
async function attachChunkSnippets(
  store: StorePort,
  results: SearchResult[],
  query: string,
  options: SearchOptions,
  loadedChunks: Map<string, ChunkRow[]> | undefined
): Promise<void> {
  const terms = createSnippetTerms(query);
  const hashes = [
    ...new Set(
      results
        .map((result) => result.conversion?.mirrorHash)
        .filter((hash): hash is string => Boolean(hash))
    ),
  ];
  if (!terms || hashes.length === 0) return;
  const read = await readChunkTermSets(store, hashes, terms, loadedChunks);
  if (!read) return;
  const weights = snippetTermWeights([...read.termSets.values()].flat());

  const chosen = results.map((result) => {
    const mirrorHash = result.conversion?.mirrorHash;
    if (!mirrorHash) return undefined;
    const steeredSeq = result[SEARCH_RESULT_PLANNER_METADATA]?.seq;
    const candidates = read.termSets.get(mirrorHash) ?? [];
    const seq = pickSnippetSeq(
      options.intent
        ? candidates.filter((entry) => entry.seq === steeredSeq)
        : candidates,
      weights
    );
    return seq === undefined ? undefined : { mirrorHash, seq };
  });
  let chunks = read.chunks;
  if (!chunks) {
    const chosenKeys = chosen.filter((key) => key !== undefined);
    if (chosenKeys.length === 0) return;
    const fetched = store.getChunksBySequenceBatch
      ? await store.getChunksBySequenceBatch(chosenKeys)
      : await store.getChunksBatch(hashes);
    if (!fetched.ok) return;
    chunks = fetched.value;
  }
  const getChunk = createChunkLookup(chunks);

  for (const [index, result] of results.entries()) {
    const key = chosen[index];
    const chunk = key ? getChunk(key.mirrorHash, key.seq) : undefined;
    if (!(key && chunk)) continue;
    const cleaned = cleanDisplaySnippet(
      renderChunkSnippet(chunk.text, terms, weights),
      chunk.text
    );
    result.line = chunk.startLine + cleaned.startLineOffset;
    result.snippet = cleaned.text;
    result.snippetLanguage = chunk.language ?? undefined;
    result.snippetRange = { startLine: result.line, endLine: chunk.endLine };
    const coordinates = {
      mirrorHash: key.mirrorHash,
      seq: chunk.seq,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      passageHash: passageHash(chunk.text),
    };
    const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
    if (metadata) {
      Object.assign(metadata, coordinates);
    } else {
      attachSearchResultPlannerMetadata(result, {
        retrievalRank: 0,
        sources: ["bm25"],
        graphExpanded: false,
        ...coordinates,
      });
    }
  }
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
  if (options.filter !== undefined)
    options = {
      ...options,
      filter: normalizeMetadataPredicate(options.filter),
    };
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
  const queryLanguage = options.lang ?? detectQueryLanguage(query).bcp47;

  // Run FTS search (ranking only; snippets come from chunks of the final rows)
  const ftsResult = await store.searchFts(query, {
    limit: retrievalLimit,
    collection: options.collection,
    collections: options.collections,
    allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
    exclude: options.exclude,
    relPathPrefix: options.retrievalScope?.relPathPrefix,
    language: options.lang,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: temporalRange.since,
    until: temporalRange.until,
    categories: options.categories,
    author: options.author,
    filter: options.filter,
    memoryScopesAny: options.memoryFilter?.scopes,
    excludeSuperseded: options.memoryFilter?.excludeSuperseded,
    anyTerm: options.anyTerm,
    minRelativeScore: options.minRelativeScore,
    nameBoost: options.nameBoost ?? true,
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
    {
      collection: string;
      contentTypeSource?: string;
      rawScore: number;
    }
  >();

  // Exact sequences suffice unless selection needs whole-document evidence.
  // In default mode (no --full, --line-numbers, --intent, or --exclude), defer
  // chunk loading, display-snippet cleaning, and passage hashing until after
  // slicing to the final `limit` rows.
  const uniqueHashes = [
    ...new Set(
      ftsResult.value.map((f) => f.mirrorHash).filter((h): h is string => !!h)
    ),
  ];
  const needsAllChunks = Boolean(options.intent || options.exclude?.length);
  const deferDefaultChunks =
    !options.full && !options.lineNumbers && !needsAllChunks;
  let chunksMapResult:
    | Awaited<ReturnType<StorePort["getChunksBatch"]>>
    | undefined;
  if (!deferDefaultChunks) {
    chunksMapResult =
      store.getChunksBySequenceBatch && !needsAllChunks
        ? await store.getChunksBySequenceBatch(
            ftsResult.value
              .filter((row) => !!row.mirrorHash)
              .map((row) => ({ mirrorHash: row.mirrorHash!, seq: row.seq }))
          )
        : await store.getChunksBatch(uniqueHashes);
  }
  const getChunk = chunksMapResult?.ok
    ? createChunkLookup(chunksMapResult.value)
    : () => undefined;
  const allChunks =
    chunksMapResult?.ok && (needsAllChunks || !store.getChunksBySequenceBatch)
      ? chunksMapResult.value
      : undefined;
  const excludeTermsLower = compileExcludeTerms(options.exclude);
  const queryTerms = options.intent ? extractSteeringTerms(query) : undefined;
  const intentTerms = options.intent
    ? extractSteeringTerms(options.intent)
    : undefined;
  const deferredChunkByResult = new WeakMap<SearchResult, ChunkRow>();
  const deferredFtsByResult = new WeakMap<SearchResult, FtsResult>();

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

    // Get chunk via O(1) lookup (skipped when deferring default-mode chunks)
    const rawChunk =
      !deferDefaultChunks && fts.mirrorHash
        ? (getChunk(fts.mirrorHash, fts.seq) ?? null)
        : null;
    const chunk =
      options.intent && fts.mirrorHash
        ? (selectBestChunkForSteering(
            chunksMapResult?.ok
              ? (chunksMapResult.value.get(fts.mirrorHash) ?? [])
              : [],
            query,
            options.intent,
            {
              preferredSeq: rawChunk?.seq ?? fts.seq,
              intentWeight: 0.3,
              queryTerms,
              intentTerms,
            }
          ) ?? rawChunk)
        : rawChunk;

    if (excludeTermsLower) {
      const excluded =
        matchesExcludedText(
          [fts.title ?? "", fts.recordSourcePath ?? fts.relPath ?? ""],
          excludeTermsLower,
          true
        ) ||
        matchesExcludedChunks(
          chunksMapResult?.ok && fts.mirrorHash
            ? (chunksMapResult.value.get(fts.mirrorHash) ?? [])
            : [],
          excludeTermsLower,
          true
        );
      if (excluded) {
        continue;
      }
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
    const result = buildSearchResult({
      fts,
      chunk,
      collectionPath,
      options,
      deferPassageHash: true,
    });
    if (chunk) deferredChunkByResult.set(result, chunk);
    if (deferDefaultChunks) deferredFtsByResult.set(result, fts);
    if (fts.collection) {
      scoringByResult.set(result, {
        collection: fts.collection,
        contentTypeSource: fts.contentTypeSource,
        rawScore: fts.score,
      });
    }
    results.push(result);
  }

  // For --full, defer full content fetch until after filtering, sorting, and slicing to `limit`
  if (options.full) {
    // Sort by raw BM25 score (smaller = better) before building results
    const sortedEntries = (
      auxiliaryRankingActive ? fullAffinityEntries : [...bestByDocid.values()]
    ).sort((a, b) => a.score - b.score);

    for (const { fts, chunk } of sortedEntries) {
      const collectionPath = fts.collection
        ? collectionPaths.get(fts.collection)
        : undefined;
      const result = buildSearchResult({
        fts,
        chunk,
        collectionPath,
        options,
        deferPassageHash: true,
      });
      if (chunk) deferredChunkByResult.set(result, chunk);
      if (fts.collection) {
        scoringByResult.set(result, {
          collection: fts.collection,
          contentTypeSource: fts.contentTypeSource,
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
          scoring.contentTypeSource,
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
    const recencyTs = new Map<SearchResult, number>();
    for (const r of filteredResults) {
      recencyTs.set(
        r,
        resolveRecencyTimestamp(r.source.documentDate, r.source.modifiedAt)
      );
    }
    filteredResults.sort((a, b) => {
      const aTs = recencyTs.get(a) ?? 0;
      const bTs = recencyTs.get(b) ?? 0;
      if (aTs !== bTs) {
        return bTs - aTs;
      }
      return b.score - a.score;
    });
  } else if (auxiliaryRankingActive) {
    sortByFinalScoreStable(filteredResults);
  }

  const finalResults = filteredResults.slice(0, limit);
  if (options.full && finalResults.length > 0) {
    const fullHashes = [
      ...new Set(
        finalResults
          .map((r) => r.conversion?.mirrorHash)
          .filter((mirrorHash): mirrorHash is string => Boolean(mirrorHash))
      ),
    ];
    if (fullHashes.length > 0) {
      const fullContentResult = await getContentBatch(store, fullHashes);
      if (!fullContentResult.ok) {
        return err("QUERY_FAILED", fullContentResult.error.message);
      }
      for (const result of finalResults) {
        const hash = result.conversion?.mirrorHash;
        const fullContent = hash
          ? fullContentResult.value.get(hash)
          : undefined;
        if (fullContent) {
          result.snippet = fullContent;
          result.snippetRange = undefined;
          const originalChunk = deferredChunkByResult.get(result);
          if (originalChunk) {
            result.line = originalChunk.startLine;
          }
        }
      }
    }
  } else if (!(options.full || options.lineNumbers)) {
    await attachChunkSnippets(store, finalResults, query, options, allChunks);
    if (deferDefaultChunks) {
      const missingFallback: Array<{ result: SearchResult; fts: FtsResult }> =
        [];
      for (const result of finalResults) {
        if (result[SEARCH_RESULT_PLANNER_METADATA]) continue;
        const fts = deferredFtsByResult.get(result);
        if (fts?.mirrorHash) {
          missingFallback.push({ result, fts });
        }
      }
      if (missingFallback.length > 0) {
        const fallbackHashes = [
          ...new Set(missingFallback.map(({ fts }) => fts.mirrorHash!)),
        ];
        const fallbackRes = store.getChunksBySequenceBatch
          ? await store.getChunksBySequenceBatch(
              missingFallback.map(({ fts }) => ({
                mirrorHash: fts.mirrorHash!,
                seq: fts.seq,
              }))
            )
          : await store.getChunksBatch(fallbackHashes);
        if (fallbackRes.ok) {
          const getFallbackChunk = createChunkLookup(fallbackRes.value);
          for (const { result, fts } of missingFallback) {
            const chunk = getFallbackChunk(fts.mirrorHash!, fts.seq);
            if (!chunk) continue;
            const cleaned = cleanDisplaySnippet(chunk.text, chunk.text);
            result.snippet = cleaned.text;
            result.line = chunk.startLine + cleaned.startLineOffset;
            result.snippetLanguage = chunk.language ?? undefined;
            result.snippetRange = {
              startLine: result.line,
              endLine: chunk.endLine,
            };
            attachSearchResultPlannerMetadata(result, {
              retrievalRank: 0,
              mirrorHash: fts.mirrorHash!,
              seq: chunk.seq,
              sources: ["bm25"],
              graphExpanded: false,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              passageHash: passageHash(chunk.text),
            });
          }
        }
      }
    }
  }
  for (const [index, result] of finalResults.entries()) {
    const metadata = result[SEARCH_RESULT_PLANNER_METADATA];
    if (metadata) {
      metadata.retrievalRank = index + 1;
      if (!metadata.passageHash) {
        const chunk = deferredChunkByResult.get(result);
        if (chunk) metadata.passageHash = passageHash(chunk.text);
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
      mode: "bm25",
      totalResults: Math.min(filteredResults.length, limit),
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
