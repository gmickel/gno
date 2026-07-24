/** Candidate execution with exact persisted replay scopes. */

import type { HybridSearchDeps } from "../pipeline/hybrid";
import type {
  HybridSearchOptions,
  SearchResult,
  SearchResults,
  SearchResultsTraceMetadata,
} from "../pipeline/types";
import type { StoreResult } from "../store/types";
import type { RetrievalQrelsCase } from "./retrieval-qrels";
import type { RetrievalReplayCandidate } from "./retrieval-replay-types";

import { parseUri } from "../app/constants";
import { normalizeContentTypes } from "../config";
import { searchHybrid } from "../pipeline/hybrid";
import { searchBm25 } from "../pipeline/search";
import { SEARCH_RESULTS_TRACE_METADATA } from "../pipeline/types";
import { searchVector } from "../pipeline/vsearch";
import { err, ok } from "../store/types";

export interface RetrievalReplayDeps extends HybridSearchDeps {
  indexName?: string;
  modelUris?: string[];
}

export const retrievalReplayLimit = (
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate
): number => {
  const persistedLimit =
    typeof source.query.filters.limit === "number"
      ? source.query.filters.limit
      : undefined;
  return (
    candidate.limit ??
    persistedLimit ??
    (source.baseline.ranked.length > 0 ? source.baseline.ranked.length : 20)
  );
};

export const retrievalReplayTraceMetadata = (
  candidate: RetrievalReplayCandidate,
  result: SearchResults
): SearchResultsTraceMetadata => {
  const persisted = result[SEARCH_RESULTS_TRACE_METADATA];
  if (persisted) return persisted;
  if (candidate.type === "bm25") {
    return {
      capabilityOutcomes: [{ capability: "lexical_search", status: "used" }],
      fallbackCodes: [],
    };
  }
  if (candidate.type === "vector") {
    return {
      capabilityOutcomes: [{ capability: "semantic_search", status: "used" }],
      fallbackCodes: [],
    };
  }
  return {
    capabilityOutcomes: [
      { capability: "lexical_search", status: "used" },
      result.meta.vectorsUsed
        ? { capability: "semantic_search", status: "used" }
        : {
            capability: "semantic_search",
            status: "unavailable",
            reasonCode: "vector_unavailable",
          },
    ],
    fallbackCodes: result.meta.vectorsUsed ? [] : ["vector_unavailable"],
  };
};

export const buildRetrievalReplaySearchOptions = (
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate,
  collectionOverride?: string,
  retrievalScope?: HybridSearchOptions["retrievalScope"]
): HybridSearchOptions => {
  const filters = source.query.filters;
  return {
    limit:
      candidate.limit ??
      (typeof filters.limit === "number"
        ? filters.limit
        : source.baseline.ranked.length || undefined),
    minScore:
      typeof filters.minScore === "number" ? filters.minScore : undefined,
    collection:
      collectionOverride ??
      (typeof filters.collection === "string" ? filters.collection : undefined),
    retrievalScope,
    lang: typeof filters.lang === "string" ? filters.lang : undefined,
    full: typeof filters.full === "boolean" ? filters.full : undefined,
    lineNumbers:
      typeof filters.lineNumbers === "boolean"
        ? filters.lineNumbers
        : undefined,
    tagsAll: Array.isArray(filters.tagsAll)
      ? (filters.tagsAll as string[])
      : undefined,
    tagsAny: Array.isArray(filters.tagsAny)
      ? (filters.tagsAny as string[])
      : undefined,
    since: typeof filters.since === "string" ? filters.since : undefined,
    until: typeof filters.until === "string" ? filters.until : undefined,
    categories: Array.isArray(filters.categories)
      ? (filters.categories as string[])
      : undefined,
    author: typeof filters.author === "string" ? filters.author : undefined,
    intent: typeof filters.intent === "string" ? filters.intent : undefined,
    exclude: Array.isArray(filters.exclude)
      ? (filters.exclude as string[])
      : undefined,
    graph: typeof filters.graph === "boolean" ? filters.graph : undefined,
    noGraph: typeof filters.noGraph === "boolean" ? filters.noGraph : undefined,
    explain: typeof filters.explain === "boolean" ? filters.explain : undefined,
    queryLanguageHint:
      typeof filters.queryLanguageHint === "string"
        ? filters.queryLanguageHint
        : undefined,
    candidateLimit:
      candidate.candidateLimit ??
      (typeof filters.candidateLimit === "number"
        ? filters.candidateLimit
        : undefined),
    noExpand:
      candidate.noExpand ??
      (typeof filters.noExpand === "boolean" ? filters.noExpand : undefined),
    noRerank:
      candidate.noRerank ??
      (typeof filters.noRerank === "boolean" ? filters.noRerank : undefined),
    queryModes:
      candidate.queryModes ??
      (Array.isArray(filters.queryModes)
        ? (filters.queryModes as RetrievalReplayCandidate["queryModes"])
        : undefined),
  };
};

const runCandidateOnce = async (
  deps: RetrievalReplayDeps,
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate,
  options: HybridSearchOptions
): Promise<StoreResult<SearchResults>> => {
  if (candidate.type === "bm25") {
    return searchBm25(deps.store, source.query.text, {
      ...options,
      contentTypeRules: normalizeContentTypes(deps.config.contentTypes ?? [])
        .rules,
    });
  }
  if (candidate.type === "vector") {
    if (!(deps.vectorIndex && deps.embedPort)) {
      return err("QUERY_FAILED", "Candidate vector pipeline is unavailable");
    }
    return searchVector(
      {
        store: deps.store,
        config: deps.config,
        vectorIndex: deps.vectorIndex,
        embedPort: deps.embedPort,
      },
      source.query.text,
      options
    );
  }
  return searchHybrid(deps, source.query.text, options);
};

interface ReplayScope {
  collections: Array<string | undefined>;
  uriPrefix: ReturnType<typeof parseUri>;
  finalLimit: number;
  fetchLimit: number;
}

const resolveReplayScope = (
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate
): StoreResult<ReplayScope> => {
  const filters = source.query.filters;
  const singular =
    typeof filters.collection === "string" ? filters.collection : undefined;
  const plural = Array.isArray(filters.collections)
    ? filters.collections.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const prefixValue =
    typeof filters.uriPrefix === "string" ? filters.uriPrefix : undefined;
  const uriPrefix = prefixValue ? parseUri(prefixValue) : null;
  if (prefixValue && !uriPrefix) {
    return err("INVALID_INPUT", "Persisted replay URI prefix is invalid");
  }
  if (singular && plural.length > 0 && !plural.includes(singular)) {
    return err(
      "INVALID_INPUT",
      "Persisted singular and plural collection filters conflict"
    );
  }
  let collections: Array<string | undefined> =
    plural.length > 0
      ? [...new Set(plural)].sort()
      : singular
        ? [singular]
        : [undefined];
  if (singular) collections = [singular];
  if (uriPrefix) {
    if (
      collections[0] !== undefined &&
      !collections.includes(uriPrefix.collection)
    ) {
      return err(
        "INVALID_INPUT",
        "Persisted URI prefix falls outside the collection scope"
      );
    }
    collections = [uriPrefix.collection];
  }
  const finalLimit = retrievalReplayLimit(source, candidate);
  const persistedCandidateLimit =
    typeof filters.candidateLimit === "number"
      ? filters.candidateLimit
      : undefined;
  const fetchLimit = uriPrefix
    ? Math.max(
        finalLimit,
        candidate.candidateLimit ?? persistedCandidateLimit ?? 100
      )
    : finalLimit;
  return ok({ collections, uriPrefix, finalLimit, fetchLimit });
};

const resultInPrefix = (
  result: SearchResult,
  prefix: NonNullable<ReplayScope["uriPrefix"]>
): boolean => {
  const parsed = parseUri(result.uri);
  return Boolean(
    parsed &&
    parsed.collection === prefix.collection &&
    (prefix.path === "" ||
      parsed.path === prefix.path ||
      parsed.path.startsWith(`${prefix.path}/`))
  );
};

const compareReplayResults = (
  left: SearchResult,
  right: SearchResult
): number =>
  right.score - left.score ||
  left.uri.localeCompare(right.uri) ||
  (left.line ?? 0) - (right.line ?? 0) ||
  left.docid.localeCompare(right.docid);

export const runRetrievalReplayCandidate = async (
  deps: RetrievalReplayDeps,
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate
): Promise<StoreResult<SearchResults>> => {
  const scope = resolveReplayScope(source, candidate);
  if (!scope.ok) return scope;
  let retrievalScope: HybridSearchOptions["retrievalScope"];
  if (scope.value.uriPrefix) {
    const documents = await deps.store.listDocuments(
      scope.value.uriPrefix.collection
    );
    if (!documents.ok) return documents;
    const prefixPath = scope.value.uriPrefix.path;
    retrievalScope = {
      ...(prefixPath === "" ? {} : { relPathPrefix: prefixPath }),
      allowedMirrorHashes: [
        ...new Set(
          documents.value
            .filter(
              (document) =>
                document.active &&
                document.mirrorHash &&
                (prefixPath === "" ||
                  document.relPath === prefixPath ||
                  document.relPath.startsWith(`${prefixPath}/`))
            )
            .map((document) => document.mirrorHash!)
        ),
      ].sort(),
    };
  }
  const outputs: SearchResults[] = [];
  for (const collection of scope.value.collections) {
    const options = buildRetrievalReplaySearchOptions(
      source,
      candidate,
      collection,
      retrievalScope
    );
    options.limit = scope.value.fetchLimit;
    const result = await runCandidateOnce(deps, source, candidate, options);
    if (!result.ok) return result;
    outputs.push(result.value);
  }
  const unique = new Map<string, SearchResult>();
  for (const output of outputs) {
    for (const result of output.results) {
      if (
        scope.value.uriPrefix &&
        !resultInPrefix(result, scope.value.uriPrefix)
      ) {
        continue;
      }
      const key = `${result.docid}\0${result.conversion?.mirrorHash ?? ""}\0${
        result.snippetRange?.startLine ?? result.line ?? 0
      }\0${result.snippetRange?.endLine ?? result.line ?? 0}`;
      const previous = unique.get(key);
      if (!previous || compareReplayResults(result, previous) < 0) {
        unique.set(key, result);
      }
    }
  }
  const results = [...unique.values()]
    .sort(compareReplayResults)
    .slice(0, scope.value.finalLimit);
  const first = outputs[0];
  if (!first) {
    return err("QUERY_FAILED", "Candidate replay produced no search response");
  }
  const output: SearchResults = {
    results,
    meta: {
      ...first.meta,
      totalResults: results.length,
      collection:
        scope.value.collections.length === 1
          ? scope.value.collections[0]
          : undefined,
    },
  };
  const capabilityOutcomes = outputs
    .flatMap(
      (item) => item[SEARCH_RESULTS_TRACE_METADATA]?.capabilityOutcomes ?? []
    )
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidateItem) =>
            candidateItem.capability === item.capability &&
            candidateItem.status === item.status &&
            candidateItem.reasonCode === item.reasonCode
        ) === index
    )
    .sort((left, right) =>
      `${left.capability}\0${left.status}\0${left.reasonCode ?? ""}`.localeCompare(
        `${right.capability}\0${right.status}\0${right.reasonCode ?? ""}`
      )
    );
  const fallbackCodes = [
    ...new Set(
      outputs.flatMap(
        (item) => item[SEARCH_RESULTS_TRACE_METADATA]?.fallbackCodes ?? []
      )
    ),
  ].sort();
  if (capabilityOutcomes.length > 0 || fallbackCodes.length > 0) {
    Object.defineProperty(output, SEARCH_RESULTS_TRACE_METADATA, {
      enumerable: false,
      value: { capabilityOutcomes, fallbackCodes },
    });
  }
  return ok(output);
};
