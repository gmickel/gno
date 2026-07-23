/**
 * Deterministic retrieval planning for Context Capsules.
 *
 * Retrieval, strict context snapshot loading, exact line materialization, and
 * canonical payload projection are injected. Indexed text is only compared as
 * untrusted data; it never controls planner behavior.
 */

import type {
  FusionSource,
  HybridSearchOptions,
  QueryModeInput,
  SearchMeta,
  SearchResult,
  SearchResults,
} from "../pipeline/types";
import type { ContextRow } from "../store/types";
import type {
  ContextBudgetLimits,
  ContextCandidateReference,
  ContextCanonicalProjection,
  ContextOmission,
  ContextSelectionResult,
  ContextSelectionState,
  MaterializedContextCandidate,
} from "./context-budget";
import type { ContextConfiguredGuidance } from "./context-guidance";

import { decorateUriForIndex } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";
import { resolveTemporalRange } from "../pipeline/temporal";
import {
  SEARCH_RESULT_PLANNER_METADATA,
  type SearchResultPlannerMetadata,
} from "../pipeline/types";
import { selectContextEvidence } from "./context-budget";
import {
  contextCapsuleOmissionIdentity,
  sha256Text,
} from "./context-capsule-validation";
import {
  candidateMatchesContextFacet,
  deriveContextFacetPlan,
  normalizeContextText,
} from "./context-facets";
import {
  contextGuidanceResultIdentity,
  resolveContextGuidance,
} from "./context-guidance";
import { isContextUriInScope } from "./context-scope";

export { deriveContextFacets } from "./context-facets";
export type { ContextConfiguredGuidance } from "./context-guidance";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DOCID_PATTERN = /^#[a-f0-9]{6,}$/;
export interface ContextRetrievalRequest extends HybridSearchOptions {
  query: string;
  collection?: string;
  noExpand: true;
}

export interface ContextRetrievalCandidate {
  result: SearchResult;
  retrievalRank: number;
  retrievalSources: FusionSource[];
  graphExpanded: boolean;
  contextIds: string[];
  observedAt: string | null;
}

export interface ContextMaterializedDraft<T = unknown> {
  uri: string;
  docid: string;
  startLine: number;
  endLine: number;
  text: string;
  sourceHash: string;
  mirrorHash: string;
  value: T;
}

export type ContextMaterialization<T = unknown> =
  | { ok: true; candidate: ContextMaterializedDraft<T> }
  | { ok: false; reference: ContextCandidateReference };

export interface ContextCompilerInput {
  goal: string;
  query?: string;
  indexName: string;
  collections: string[];
  uriPrefix?: string | null;
  queryModes?: QueryModeInput[];
  tagsAll?: string[];
  tagsAny?: string[];
  categories?: string[];
  author?: string;
  lang?: string;
  since?: string;
  until?: string;
  graph?: boolean;
  limit?: number;
  candidateLimit?: number;
  /** Frozen once by the caller; never defaulted from wall-clock time. */
  temporalNow: Date | string;
  /** Stable observation boundary. Use null when no durable timestamp exists. */
  observedAt: string | null;
  limits: ContextBudgetLimits;
  /** One caller-owned, successfully loaded context snapshot for this plan. */
  contextSnapshot: ContextRow[];
}

export interface ContextRetrievalPlan {
  facets: string[];
  queryVariants: string[];
  retrievalSources: FusionSource[];
  semanticSearch: boolean;
  reranked: boolean;
  graphExpansion: boolean;
  graphFallbackReasons: string[];
}

export interface ContextCanonicalPlanDraft<T = unknown> {
  goal: string;
  query: string;
  indexName: string;
  collections: string[];
  uriPrefix: string | null;
  limits: ContextBudgetLimits;
  retrieval: ContextRetrievalPlan;
  configuredContexts: ContextConfiguredGuidance[];
  selection: ContextSelectionState<T>;
}

export interface ContextCompilerDeps<T = unknown, P = unknown> {
  retrieve: (request: ContextRetrievalRequest) => Promise<SearchResults>;
  /** Results must align one-for-one with the supplied candidates. */
  materializeCandidates: (
    candidates: ContextRetrievalCandidate[]
  ) => Promise<ContextMaterialization<T>[]>;
  projectCanonical: (
    draft: ContextCanonicalPlanDraft<T>
  ) => ContextCanonicalProjection<P> | null;
}

export interface ContextEvidencePlan<
  T = unknown,
  P = unknown,
> extends ContextSelectionResult<T, P> {
  goal: string;
  query: string;
  indexName: string;
  collections: string[];
  uriPrefix: string | null;
  retrieval: ContextRetrievalPlan;
  configuredContexts: ContextConfiguredGuidance[];
}

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const plannerMeta = (
  result: SearchResult,
  fallbackRank: number
): SearchResultPlannerMetadata =>
  result[SEARCH_RESULT_PLANNER_METADATA] ?? {
    retrievalRank: fallbackRank,
    mirrorHash: result.conversion?.mirrorHash ?? "",
    seq: 0,
    sources: [],
    graphExpanded: false,
  };

const compareSearchResults = (
  left: SearchResult,
  right: SearchResult
): number =>
  compareCodeUnits(left.uri, right.uri) ||
  (left.snippetRange?.startLine ?? 0) - (right.snippetRange?.startLine ?? 0) ||
  compareCodeUnits(
    left.source.sourceHash ?? "",
    right.source.sourceHash ?? ""
  ) ||
  compareCodeUnits(left.docid, right.docid);

const referenceFromResult = (
  result: SearchResult
): ContextCandidateReference => {
  const sourceHash = result.source.sourceHash;
  const mirrorHash = result.conversion?.mirrorHash;
  if (
    !sourceHash ||
    !mirrorHash ||
    !HASH_PATTERN.test(sourceHash) ||
    !HASH_PATTERN.test(mirrorHash) ||
    !DOCID_PATTERN.test(result.docid)
  ) {
    throw new Error(`Hybrid result lacks canonical provenance: ${result.uri}`);
  }
  const startLine = result.snippetRange?.startLine ?? null;
  const endLine = result.snippetRange?.endLine ?? null;
  const passageHash = startLine && endLine ? sha256Text(result.snippet) : null;
  const base = {
    uri: result.uri,
    docid: result.docid,
    startLine,
    endLine,
    passageHash,
    sourceHash,
    mirrorHash,
  };
  return { candidateId: contextCapsuleOmissionIdentity(base), ...base };
};

const normalizeMaterialized = <T>(
  draft: ContextMaterializedDraft<T>,
  facets: string[],
  retrievalRank: number
): MaterializedContextCandidate<T> => {
  const text = draft.text;
  if (
    !text ||
    text.includes("\r") ||
    draft.startLine < 1 ||
    draft.endLine < draft.startLine ||
    text.split("\n").length !== draft.endLine - draft.startLine + 1 ||
    !HASH_PATTERN.test(draft.sourceHash) ||
    !HASH_PATTERN.test(draft.mirrorHash) ||
    !DOCID_PATTERN.test(draft.docid)
  ) {
    throw new Error(`Invalid materialized Context coordinates: ${draft.uri}`);
  }
  const passageHash = sha256Text(text);
  const base = {
    uri: draft.uri,
    docid: draft.docid,
    startLine: draft.startLine,
    endLine: draft.endLine,
    passageHash,
    sourceHash: draft.sourceHash,
    mirrorHash: draft.mirrorHash,
  };
  return {
    candidateId: contextCapsuleOmissionIdentity(base),
    ...base,
    text,
    facets,
    retrievalRank,
    value: draft.value,
  };
};

const hasSameSourceIdentity = (
  value: Pick<
    ContextCandidateReference,
    "uri" | "docid" | "sourceHash" | "mirrorHash"
  >,
  reference: ContextCandidateReference
): boolean =>
  value.uri === reference.uri &&
  value.docid === reference.docid &&
  value.sourceHash === reference.sourceHash &&
  value.mirrorHash === reference.mirrorHash;

const mergeMeta = (
  metas: SearchMeta[]
): Omit<
  ContextRetrievalPlan,
  "facets" | "queryVariants" | "retrievalSources"
> => ({
  semanticSearch: metas.some((meta) => meta.vectorsUsed === true),
  reranked: metas.some((meta) => meta.reranked === true),
  graphExpansion: metas.some((meta) => meta.graphExpansion?.enabled === true),
  graphFallbackReasons: [
    ...new Set(
      metas.flatMap((meta) => meta.graphExpansion?.fallbackReasons ?? [])
    ),
  ].sort(compareCodeUnits),
});

const distributedLimit = (
  total: number | undefined,
  requestIndex: number,
  requestCount: number
): number | undefined => {
  if (total === undefined) return undefined;
  const base = Math.floor(total / requestCount);
  return base + (requestIndex < total % requestCount ? 1 : 0);
};

/** Build a deterministic evidence plan; no answer generation occurs here. */
export const planContextEvidence = async <T, P>(
  input: ContextCompilerInput,
  deps: ContextCompilerDeps<T, P>
): Promise<ContextEvidencePlan<T, P>> => {
  const goal = normalizeContextText(input.goal);
  const query = normalizeContextText(input.query ?? input.goal);
  if (!goal || !query)
    throw new Error("Context goal and query must be non-empty");
  const now =
    input.temporalNow instanceof Date
      ? new Date(input.temporalNow)
      : new Date(input.temporalNow);
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid frozen temporal now");
  const observedAt =
    input.observedAt === null ? null : new Date(input.observedAt).toISOString();
  const queryModes = input.queryModes ?? [];
  const facetPlan = deriveContextFacetPlan(query, queryModes);
  const facets = facetPlan.map((facet) => facet.value);
  const queryVariants = [
    ...new Set([
      query,
      ...queryModes.map((mode) => normalizeContextText(mode.text)),
    ]),
  ];
  const temporalRange = resolveTemporalRange(
    query,
    input.since,
    input.until,
    now
  );
  const collections = [...new Set(input.collections)].sort(compareCodeUnits);
  const indexName = canonicalizeIndexName(input.indexName);
  const collectionRequests = collections.length > 0 ? collections : [undefined];
  const requestCount = collectionRequests.length;
  const responses: SearchResults[] = [];
  for (const [requestIndex, collection] of collectionRequests.entries()) {
    const resultLimit = distributedLimit(
      input.limit,
      requestIndex,
      requestCount
    );
    const rerankLimit = distributedLimit(
      input.candidateLimit,
      requestIndex,
      requestCount
    );
    const hasRerankBudget = rerankLimit === undefined || rerankLimit > 0;
    responses.push(
      await deps.retrieve({
        query,
        collection,
        noExpand: true,
        queryModes,
        tagsAll: input.tagsAll,
        tagsAny: input.tagsAny,
        categories: input.categories,
        author: input.author,
        lang: input.lang,
        since: temporalRange.since,
        until: temporalRange.until,
        graph: hasRerankBudget ? input.graph : false,
        noRerank: hasRerankBudget ? undefined : true,
        limit: resultLimit === undefined ? undefined : Math.max(1, resultLimit),
        candidateLimit:
          rerankLimit === undefined ? undefined : Math.max(1, rerankLimit),
      })
    );
  }
  const decoratedResults = responses
    .flatMap((response) => response.results)
    .map((result) => ({
      ...result,
      uri: decorateUriForIndex(result.uri, indexName),
    }));
  const results = decoratedResults
    .map((result, index) => ({
      result,
      retrievalRank: plannerMeta(result, index + 1).retrievalRank,
    }))
    .sort(
      (left, right) =>
        left.retrievalRank - right.retrievalRank ||
        compareSearchResults(left.result, right.result)
    )
    .slice(0, input.limit ?? decoratedResults.length)
    .map(({ result }) => result)
    .sort(compareSearchResults);
  const uriPrefix =
    input.uriPrefix === null || input.uriPrefix === undefined
      ? null
      : decorateUriForIndex(input.uriPrefix, indexName);
  const inScopeResults = results.filter((result) =>
    isContextUriInScope(result.uri, indexName, collections, uriPrefix)
  );
  const guidance = resolveContextGuidance(
    input.contextSnapshot,
    inScopeResults,
    indexName
  );
  const filteredFacetMatches = new Set<string>();
  const initialOmissions: ContextOmission[] = [];
  const materialized: MaterializedContextCandidate<T>[] = [];
  const retrievalSources = new Set<FusionSource>();
  const plannedCandidates: ContextRetrievalCandidate[] = [];
  const referencesByCandidate: ContextCandidateReference[] = [];

  for (const [index, result] of results.entries()) {
    const meta = plannerMeta(result, index + 1);
    for (const source of meta.sources) retrievalSources.add(source);
    const retrievalReference = referenceFromResult(result);
    if (!isContextUriInScope(result.uri, indexName, collections, uriPrefix)) {
      for (const facet of facetPlan) {
        if (
          candidateMatchesContextFacet(
            facet,
            result,
            result.snippet,
            temporalRange
          )
        ) {
          filteredFacetMatches.add(facet.value);
        }
      }
      initialOmissions.push({
        ...retrievalReference,
        reason: "filtered_by_scope",
      });
      continue;
    }
    plannedCandidates.push({
      result,
      retrievalRank: meta.retrievalRank,
      retrievalSources: [...meta.sources].sort(compareCodeUnits),
      graphExpanded: meta.graphExpanded,
      contextIds:
        guidance.idsByResultIdentity.get(
          contextGuidanceResultIdentity(result)
        ) ?? [],
      observedAt,
    });
    referencesByCandidate.push(retrievalReference);
  }

  const outcomes =
    plannedCandidates.length === 0
      ? []
      : await deps.materializeCandidates(plannedCandidates);
  if (outcomes.length !== plannedCandidates.length) {
    throw new Error("Context materialization batch must align with candidates");
  }
  for (const [index, plannedCandidate] of plannedCandidates.entries()) {
    const outcome = outcomes[index];
    const retrievalReference = referencesByCandidate[index];
    if (!outcome || !retrievalReference) {
      throw new Error("Context materialization batch alignment failed");
    }
    const result = plannedCandidate.result;
    if (
      !hasSameSourceIdentity(
        outcome.ok ? outcome.candidate : outcome.reference,
        retrievalReference
      )
    ) {
      throw new Error(`Materialized Context provenance drifted: ${result.uri}`);
    }
    if (!outcome.ok) {
      initialOmissions.push({
        ...outcome.reference,
        reason: "invalid_coordinates",
      });
      continue;
    }
    const matchedFacets = facetPlan
      .filter((facet) =>
        candidateMatchesContextFacet(
          facet,
          result,
          outcome.candidate.text,
          temporalRange
        )
      )
      .map((facet) => facet.value);
    materialized.push(
      normalizeMaterialized(
        outcome.candidate,
        matchedFacets,
        plannedCandidate.retrievalRank
      )
    );
  }

  const retrieval: ContextRetrievalPlan = {
    facets,
    queryVariants,
    retrievalSources: [...retrievalSources].sort(compareCodeUnits),
    ...mergeMeta(responses.map((response) => response.meta)),
  };
  const baseDraft = {
    goal,
    query,
    indexName,
    collections,
    uriPrefix,
    limits: input.limits,
    retrieval,
    configuredContexts: guidance.contexts,
  };
  const selection = selectContextEvidence({
    candidates: materialized,
    requestedFacets: facets,
    initialOmissions,
    filteredFacetMatches,
    limits: input.limits,
    projectCanonical: (state) =>
      deps.projectCanonical({ ...baseDraft, selection: state }),
  });
  return { ...baseDraft, ...selection };
};
