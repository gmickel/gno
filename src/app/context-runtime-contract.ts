/** Validation, projection, and fingerprint rules for Context runtime surfaces. */

import type { ContextCanonicalProjection } from "../core/context-budget";
import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextCapsulePayloadV1 } from "../core/context-capsule-schema";
import type { ContextCanonicalPlanDraft } from "../core/context-compiler";
import type { ContextEvidenceValue } from "../core/context-evidence";
import type {
  ContextCapsuleBuildInput,
  ContextCapsuleRuntimeDeps,
} from "./context-runtime-types";

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
import { resolveTemporalRange } from "../pipeline/temporal";
import { buildUri, parseUri } from "./constants";
import { ContextRuntimeError } from "./context-runtime-types";
import { canonicalizeIndexName } from "./index-name";

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FILTER_VALUES = 128;
const MAX_FILTER_LENGTH = 256;
const MAX_TEXT_LENGTH = 16_384;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalStrings = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.normalize("NFC")))].sort(
    compareCodeUnits
  );

const canonicalFilters = (
  values: readonly string[] | undefined,
  label: string
): string[] => {
  const normalized = canonicalStrings(values).map((value) => value.trim());
  if (
    normalized.length > MAX_FILTER_VALUES ||
    normalized.some(
      (value) =>
        value.length === 0 ||
        value.length > MAX_FILTER_LENGTH ||
        value.includes("\r")
    )
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      `${label} contains an invalid value`
    );
  }
  return normalized;
};

const fingerprint = (value: unknown): string =>
  sha256Text(canonicalVerifierJson(value));

const configFingerprint = (deps: ContextCapsuleRuntimeDeps): string =>
  fingerprint(deps.config);

const configuredContextFingerprint = (
  deps: ContextCapsuleRuntimeDeps
): string =>
  fingerprintContextRows(
    (deps.config.contexts ?? []).map((context) => ({
      ...context,
      syncedAt: "",
    }))
  );

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextRuntimeError(
      "invalid_budget",
      `${label} must be a positive safe integer`
    );
  }
  return value;
};

const validateCollection = (value: string): string => {
  const normalized = value.normalize("NFC");
  if (!COLLECTION_PATTERN.test(normalized)) {
    throw new ContextRuntimeError(
      "invalid_filter",
      `Invalid collection filter: ${value}`
    );
  }
  return normalized;
};

const validateUriPrefix = (
  value: string | null | undefined,
  indexName: string,
  collections: readonly string[]
): string | null => {
  if (value === undefined || value === null) return null;
  const parsed = parseUri(value);
  if (
    !parsed ||
    parsed.collection.length === 0 ||
    (parsed.indexName !== undefined &&
      canonicalizeIndexName(parsed.indexName) !== indexName) ||
    (collections.length > 0 && !collections.includes(parsed.collection))
  ) {
    throw new ContextRuntimeError(
      "invalid_uri",
      "URI prefix must be a canonical GNO reference inside the requested index and collections"
    );
  }
  if (buildUri(parsed.collection, parsed.path, { indexName }) !== value) {
    throw new ContextRuntimeError(
      "invalid_uri",
      "URI prefix must use its canonical indexed GNO representation"
    );
  }
  return value;
};

export const normalizeContextBuildInput = (
  input: ContextCapsuleBuildInput,
  defaultIndexName: string | undefined,
  now: Date
) => {
  const goal = input.goal.normalize("NFC").trim();
  const query = (input.query ?? input.goal).normalize("NFC").trim();
  if (
    !goal ||
    !query ||
    goal.length > MAX_TEXT_LENGTH ||
    query.length > MAX_TEXT_LENGTH ||
    goal.includes("\r") ||
    query.includes("\r")
  ) {
    throw new ContextRuntimeError(
      "invalid_goal",
      "Context goal and query must be non-empty canonical text"
    );
  }
  let indexName: string;
  try {
    indexName = canonicalizeIndexName(
      input.indexName ?? defaultIndexName ?? "default"
    );
  } catch (cause) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context index name is invalid",
      cause
    );
  }
  const collections = canonicalStrings(input.collections).map(
    validateCollection
  );
  if (collections.length > MAX_FILTER_VALUES) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Too many Context collection filters"
    );
  }
  const uriPrefix = validateUriPrefix(input.uriPrefix, indexName, collections);
  const budgetTokens = positiveSafeInteger(
    input.budgetTokens,
    "Context token budget"
  );
  const budgetBytes =
    input.budgetBytes === undefined
      ? Math.min(Number.MAX_SAFE_INTEGER, budgetTokens * 4)
      : positiveSafeInteger(input.budgetBytes, "Context byte budget");
  const safetyMarginTokens = input.safetyMarginTokens ?? 0;
  const safetyMarginBytes = input.safetyMarginBytes ?? 0;
  if (
    !Number.isSafeInteger(safetyMarginTokens) ||
    !Number.isSafeInteger(safetyMarginBytes) ||
    safetyMarginTokens < 0 ||
    safetyMarginBytes < 0 ||
    safetyMarginTokens >= budgetTokens ||
    safetyMarginBytes >= budgetBytes
  ) {
    throw new ContextRuntimeError(
      "invalid_budget",
      "Context safety margins must be non-negative and smaller than their budgets"
    );
  }
  const temporalRange = resolveTemporalRange(
    query,
    input.since,
    input.until,
    now
  );
  if (
    (input.since !== undefined && temporalRange.since === undefined) ||
    (input.until !== undefined && temporalRange.until === undefined) ||
    (temporalRange.since !== undefined &&
      temporalRange.until !== undefined &&
      temporalRange.since > temporalRange.until)
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context date filters are invalid or reversed"
    );
  }
  if (
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1)) ||
    (input.candidateLimit !== undefined &&
      (!Number.isSafeInteger(input.candidateLimit) ||
        input.candidateLimit < 1)) ||
    !["fast", "balanced", "thorough", undefined].includes(input.depthPolicy)
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context retrieval limits or depth policy are invalid"
    );
  }
  const author = input.author?.normalize("NFC").trim();
  const lang = input.lang?.normalize("NFC").trim();
  if (
    (input.author !== undefined && !author) ||
    (input.lang !== undefined && (!lang || lang.length > 64))
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context author or language filter is invalid"
    );
  }
  return {
    ...input,
    goal,
    query,
    indexName,
    collections,
    uriPrefix,
    tagsAll: canonicalFilters(input.tagsAll, "tagsAll"),
    tagsAny: canonicalFilters(input.tagsAny, "tagsAny"),
    categories: canonicalFilters(input.categories, "categories"),
    author,
    lang,
    since: temporalRange.since,
    until: temporalRange.until,
    budgetTokens,
    budgetBytes,
    safetyMarginTokens,
    safetyMarginBytes,
    depthPolicy: input.depthPolicy ?? "balanced",
  };
};

type NormalizedContextBuildInput = ReturnType<
  typeof normalizeContextBuildInput
>;

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

const capsuleCapabilities = (
  draft: ContextCanonicalPlanDraft<ContextEvidenceValue>,
  exactTokens: boolean
) => ({
  lexicalSearch: true as const,
  semanticSearch: draft.retrieval.semanticSearch,
  reranking: draft.retrieval.reranked,
  graphExpansion: draft.retrieval.graphExpansion,
  exactTokenCount: exactTokens,
  configuredContext: draft.configuredContexts.length > 0,
  egressPolicy: false,
});

const capsuleFallbacks = (
  capabilities: ReturnType<typeof capsuleCapabilities>
): ContextCapsulePayloadV1["fallbacks"] => [
  ...(capabilities.semanticSearch
    ? []
    : [
        {
          code: "embedding_unavailable" as const,
          capability: "semantic_search" as const,
        },
      ]),
  ...(capabilities.reranking
    ? []
    : [
        {
          code: "reranking_unavailable" as const,
          capability: "reranking" as const,
        },
      ]),
  ...(capabilities.graphExpansion
    ? []
    : [
        {
          code: "graph_unavailable" as const,
          capability: "graph_expansion" as const,
        },
      ]),
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
  const capabilities = capsuleCapabilities(draft, exactTokens);
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
      config: configFingerprint(deps),
      retrieval: retrievalFingerprint(base, snapshots.contextFingerprint),
      embeddingModel: capabilities.semanticSearch
        ? sha256Text(deps.embedPort?.modelUri ?? "")
        : null,
      rerankModel: capabilities.reranking
        ? sha256Text(deps.rerankPort?.modelUri ?? "")
        : null,
      tokenizer: exactTokens ? (deps.tokenizerFingerprint ?? null) : null,
    },
    fallbacks: capsuleFallbacks(capabilities),
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
      items: draft.selection.omissions.slice(0, 100),
      reasonCounts: draft.selection.reasonCounts,
      truncated: draft.selection.omissions.length > 100,
    },
    truncated: draft.selection.omissions.some(
      (item) => item.reason === "global_budget"
    ),
    warnings: [
      ...(draft.selection.coverage.unresolvedFacets.length > 0
        ? [{ code: "incomplete_coverage" as const }]
        : []),
      ...(draft.selection.omissions.length > 100
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
  config: configFingerprint(deps),
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
