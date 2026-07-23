/** Validation, projection, and fingerprint rules for Context runtime surfaces. */

import type { ContextCanonicalProjection } from "../core/context-budget";
import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextCapabilityState } from "../core/context-capsule-retrieval-schema";
import type { ContextCapsulePayloadV1 } from "../core/context-capsule-schema";
import type { ContextCanonicalPlanDraft } from "../core/context-compiler";
import type { ContextEvidenceValue } from "../core/context-evidence";
import type { NormalizedContextBuildInput } from "./context-runtime-input";
import type { ContextCapsuleRuntimeDeps } from "./context-runtime-types";

import {
  ContextCapsuleContractError,
  createContextCapsuleV1,
} from "../core/context-capsule";
import { sha256Text } from "../core/context-capsule-validation";
import {
  fingerprintContextRows,
  toContextCapsuleEvidence,
} from "../core/context-evidence";
import { canonicalVerifierJson } from "../core/context-verifier-canonical";
import { resolveModelUri } from "../llm/registry";

const fingerprint = (value: unknown): string =>
  sha256Text(canonicalVerifierJson(value));

export const contextRuntimeConfigFingerprint = (
  deps: Pick<ContextCapsuleRuntimeDeps, "config">
): string => fingerprint(deps.config);

const configuredContextFingerprint = (
  deps: ContextCapsuleRuntimeDeps
): string =>
  fingerprintContextRows(
    (deps.config.contexts ?? []).map((context) => ({
      ...context,
      syncedAt: "",
    }))
  );

const retrievalFingerprint = (
  capsule: Pick<
    ContextCapsuleV1,
    "goal" | "query" | "scope" | "retrieval" | "capabilities"
  >,
  contextFingerprint: string
): string =>
  fingerprint({
    capabilities: capsule.capabilities,
    contextFingerprint,
    goal: capsule.goal,
    query: capsule.query,
    retrieval: capsule.retrieval,
    scope: capsule.scope,
  });

const capabilityState = (
  requested: boolean,
  used: boolean,
  unavailableReasons: string[],
  usedReasons: string[] = []
): ContextCapabilityState => ({
  requested,
  attempted: requested,
  outcome: used ? "used" : requested ? "unavailable" : "not_requested",
  fallbackReasons: requested ? (used ? usedReasons : unavailableReasons) : [],
});

const capsuleCapabilityStates = (
  draft: ContextCanonicalPlanDraft<ContextEvidenceValue>,
  input: NormalizedContextBuildInput
) => ({
  semanticSearch: capabilityState(
    input.depthPolicy !== "fast",
    draft.retrieval.semanticSearch,
    ["embedding_unavailable"]
  ),
  reranking: capabilityState(
    input.depthPolicy !== "fast" && !input.noRerank,
    draft.retrieval.reranked,
    ["reranking_unavailable"]
  ),
  graphExpansion: capabilityState(
    input.graph,
    draft.retrieval.graphExpansion,
    draft.retrieval.graphFallbackReasons.length > 0
      ? draft.retrieval.graphFallbackReasons
      : ["graph_unavailable"],
    draft.retrieval.graphFallbackReasons
  ),
});

const capsuleCapabilities = (
  states: ReturnType<typeof capsuleCapabilityStates>,
  exactTokens: boolean,
  configuredContext: boolean
) => ({
  lexicalSearch: true as const,
  semanticSearch: states.semanticSearch.outcome === "used",
  reranking: states.reranking.outcome === "used",
  graphExpansion: states.graphExpansion.outcome === "used",
  exactTokenCount: exactTokens,
  configuredContext,
  egressPolicy: false,
});

const capsuleFallbacks = (
  capabilities: ReturnType<typeof capsuleCapabilities>,
  states: ReturnType<typeof capsuleCapabilityStates>
): ContextCapsulePayloadV1["fallbacks"] => [
  ...(states.semanticSearch.outcome === "unavailable"
    ? [
        {
          code: "embedding_unavailable" as const,
          capability: "semantic_search" as const,
        },
      ]
    : []),
  ...(states.reranking.outcome === "unavailable"
    ? [
        {
          code: "reranking_unavailable" as const,
          capability: "reranking" as const,
        },
      ]
    : []),
  ...(states.graphExpansion.outcome === "unavailable"
    ? [
        {
          code: "graph_unavailable" as const,
          capability: "graph_expansion" as const,
        },
      ]
    : []),
  ...(capabilities.exactTokenCount
    ? []
    : [
        {
          code: "tokenizer_unavailable" as const,
          capability: "token_count" as const,
        },
      ]),
  { code: "egress_policy_unavailable", capability: "egress_policy" },
];

export const projectContextCapsule = (
  draft: ContextCanonicalPlanDraft<ContextEvidenceValue>,
  snapshots: { indexFingerprint: string; contextFingerprint: string },
  input: NormalizedContextBuildInput,
  deps: ContextCapsuleRuntimeDeps
): ContextCanonicalProjection<ContextCapsuleV1> | null => {
  if (draft.selection.selected.length === 0) return null;
  const evidence = draft.selection.selected.map((candidate, index) =>
    toContextCapsuleEvidence(candidate, index + 1)
  );
  const evidenceIdsByFacet = new Map<string, string[]>();
  for (const item of evidence) {
    for (const facet of item.facets) {
      const ids = evidenceIdsByFacet.get(facet) ?? [];
      ids.push(item.evidenceId);
      evidenceIdsByFacet.set(facet, ids);
    }
  }
  const exactTokens =
    deps.countTokens !== undefined && deps.tokenizerFingerprint != null;
  const capabilityStates = capsuleCapabilityStates(draft, input);
  const capabilities = capsuleCapabilities(
    capabilityStates,
    exactTokens,
    draft.configuredContexts.length > 0
  );
  const base = {
    schemaVersion: "1.0" as const,
    coordinateSpace: "canonical_mirror" as const,
    goal: draft.goal,
    query: draft.query,
    scope: {
      indexName: draft.indexName,
      collections: draft.collections,
      uriPrefix: draft.uriPrefix,
      tagsAll: input.tagsAll,
      tagsAny: input.tagsAny,
      categories: input.categories,
      since: input.since ?? null,
      until: input.until ?? null,
    },
    retrieval: {
      depthPolicy: input.depthPolicy,
      facets: draft.retrieval.facets,
      queryVariants: draft.retrieval.queryVariants,
      expansionPolicy: "deterministic_only" as const,
      request: {
        author: input.author,
        lang: input.lang,
        intent: input.intent,
        exclude: input.exclude,
        minScore: input.minScore,
        queryModes: input.queryModes,
        limit: input.limit,
        candidateLimit: input.candidateLimit,
        graphRequested: input.graph,
        rerankRequested: input.depthPolicy !== "fast" && !input.noRerank,
      },
      capabilityStates,
      indexSnapshot: {
        before: snapshots.indexFingerprint,
        after: snapshots.indexFingerprint,
        stable: true as const,
      },
    },
    capabilities,
  };
  const payload: ContextCapsulePayloadV1 = {
    ...base,
    budget: {
      authority: "canonical_json",
      requestedTokens: input.budgetTokens,
      requestedBytes: input.budgetBytes,
      safetyMarginTokens: input.safetyMarginTokens,
      safetyMarginBytes: input.safetyMarginBytes,
      usedTokens: 1,
      usedBytes: 0,
      estimator: exactTokens ? "active_tokenizer" : "unicode_conservative",
      tokenizerFingerprint: exactTokens
        ? (deps.tokenizerFingerprint ?? null)
        : null,
    },
    fingerprints: {
      config: contextRuntimeConfigFingerprint(deps),
      retrieval: retrievalFingerprint(base, snapshots.contextFingerprint),
      embeddingModel: capabilities.semanticSearch
        ? sha256Text(deps.embedPort?.modelUri ?? "")
        : null,
      rerankModel: capabilities.reranking
        ? sha256Text(deps.rerankPort?.modelUri ?? "")
        : null,
      tokenizer: exactTokens ? (deps.tokenizerFingerprint ?? null) : null,
    },
    fallbacks: capsuleFallbacks(capabilities, capabilityStates),
    guidance: {
      extractiveOnly: true,
      evidenceTrust: "untrusted_data",
      instructionBoundary: "hard_delimited",
      configuredContexts: draft.configuredContexts,
    },
    evidence,
    coverage: {
      complete: draft.selection.coverage.unresolvedFacets.length === 0,
      requestedFacets: draft.retrieval.facets,
      coveredFacets: draft.selection.coverage.coveredFacets.map((facet) => ({
        facet,
        evidenceIds: evidenceIdsByFacet.get(facet) ?? [],
      })),
      unresolvedFacets: draft.selection.coverage.unresolvedFacets,
      gaps: draft.selection.coverage.gaps,
    },
    omissions: {
      total: draft.selection.omissions.length,
      items: draft.selection.omissions.slice(0, 20),
      reasonCounts: draft.selection.reasonCounts,
      truncated: draft.selection.omissions.length > 20,
    },
    truncated: draft.selection.omissions.some(
      (item) => item.reason === "global_budget"
    ),
    warnings: [
      ...(draft.selection.coverage.unresolvedFacets.length > 0
        ? [{ code: "incomplete_coverage" as const }]
        : []),
      ...(draft.selection.omissions.length > 20
        ? [{ code: "omissions_truncated" as const }]
        : []),
      ...(exactTokens ? [] : [{ code: "token_estimate_used" as const }]),
    ],
  };
  try {
    const value = createContextCapsuleV1(payload, {
      countTokens: deps.countTokens,
    });
    return {
      value,
      usedBytes: value.budget.usedBytes,
      usedTokens: value.budget.usedTokens,
    };
  } catch (error) {
    if (
      error instanceof ContextCapsuleContractError &&
      error.code === "invalid_budget"
    ) {
      return null;
    }
    throw error;
  }
};

export const currentContextFingerprints = (
  capsule: ContextCapsuleV1,
  deps: ContextCapsuleRuntimeDeps
) => ({
  config: contextRuntimeConfigFingerprint(deps),
  retrieval: retrievalFingerprint(capsule, configuredContextFingerprint(deps)),
  embeddingModel: capsule.capabilities.semanticSearch
    ? sha256Text(
        resolveModelUri(
          deps.config,
          "embed",
          undefined,
          capsule.scope.collections.length === 1
            ? capsule.scope.collections[0]
            : undefined
        )
      )
    : null,
  rerankModel: capsule.capabilities.reranking
    ? sha256Text(
        resolveModelUri(
          deps.config,
          "rerank",
          undefined,
          capsule.scope.collections.length === 1
            ? capsule.scope.collections[0]
            : undefined
        )
      )
    : null,
  tokenizer:
    capsule.capabilities.exactTokenCount && deps.tokenizerFingerprint
      ? deps.tokenizerFingerprint
      : null,
});
