/** Shared application boundary for Context Capsule build and verification. */

import type {
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";
import type { SearchExplain } from "../pipeline/types";
import type {
  ContextCapsuleBuildInput,
  ContextCapsuleRuntimeDeps,
} from "./context-runtime-types";

import {
  canonicalContextCapsuleJson,
  ContextCapsuleContractError,
} from "../core/context-capsule";
import { compileContextEvidence } from "../core/context-evidence";
import {
  canonicalContextCapsuleVerificationJson,
  parseCanonicalContextCapsuleForVerification,
  verifyContextCapsule,
} from "../core/context-verifier";
import { searchHybrid } from "../pipeline/hybrid";
import {
  currentContextFingerprints,
  projectContextCapsule,
} from "./context-runtime-contract";
import { normalizeContextBuildInput } from "./context-runtime-input";
import { ContextRuntimeError } from "./context-runtime-types";
import { canonicalizeIndexName } from "./index-name";

export type {
  ContextCapsuleBuildInput,
  ContextCapsuleRuntimeDeps,
  ContextDepthPolicy,
  ContextRuntimeErrorCode,
} from "./context-runtime-types";
export { ContextRuntimeError } from "./context-runtime-types";

export const CONTEXT_CAPSULE_EXPLAIN_METADATA = Symbol(
  "gno.contextCapsuleExplainMetadata"
);

export const getContextCapsuleExplain = (
  capsule: ContextCapsuleV1
): SearchExplain | undefined =>
  (
    capsule as ContextCapsuleV1 & {
      [CONTEXT_CAPSULE_EXPLAIN_METADATA]?: SearchExplain;
    }
  )[CONTEXT_CAPSULE_EXPLAIN_METADATA];

/** Build one strict Capsule through the shared compiler composition. */
export const buildContextCapsule = async (
  input: ContextCapsuleBuildInput,
  deps: ContextCapsuleRuntimeDeps
): Promise<ContextCapsuleV1> => {
  const now = new Date();
  const normalized = normalizeContextBuildInput(
    input,
    deps.indexName,
    now,
    deps.config.collections.map((collection) => collection.name)
  );
  const noRerank = normalized.depthPolicy === "fast" || normalized.noRerank;
  const plan = await compileContextEvidence<ContextCapsuleV1>(
    {
      goal: normalized.goal,
      query: normalized.query,
      indexName: normalized.indexName,
      collections: normalized.collections,
      uriPrefix: normalized.uriPrefix,
      queryModes: normalized.queryModes,
      tagsAll: normalized.tagsAll,
      tagsAny: normalized.tagsAny,
      categories: normalized.categories,
      author: normalized.author ?? undefined,
      lang: normalized.lang ?? undefined,
      intent: normalized.intent ?? undefined,
      exclude: normalized.exclude,
      minScore: normalized.minScore ?? undefined,
      since: normalized.since,
      until: normalized.until,
      graph: normalized.graph,
      noRerank: normalized.noRerank,
      limit: normalized.limit,
      candidateLimit: normalized.candidateLimit,
      temporalNow: now,
      explain: deps.explain,
      limits: {
        requestedBytes: normalized.budgetBytes,
        requestedTokens: normalized.budgetTokens,
        safetyMarginBytes: normalized.safetyMarginBytes,
        safetyMarginTokens: normalized.safetyMarginTokens,
      },
    },
    {
      store: deps.store,
      retrieve: async (request) => {
        const requestNoRerank = noRerank || request.noRerank === true;
        const result = await searchHybrid(
          {
            store: deps.store,
            config: deps.config,
            vectorIndex: deps.vectorIndex ?? null,
            embedPort: deps.embedPort ?? null,
            expandPort: null,
            rerankPort: requestNoRerank ? null : (deps.rerankPort ?? null),
          },
          request.query,
          {
            ...request,
            noRerank: requestNoRerank,
            projectAffinity: deps.projectAffinity,
            traceSession: deps.traceSession,
          }
        );
        if (!result.ok) {
          throw new ContextRuntimeError(
            "retrieval_failed",
            result.error.message,
            result.error.cause
          );
        }
        return result.value;
      },
      projectCanonical: (draft, snapshots) =>
        projectContextCapsule(draft, snapshots, normalized, deps),
    }
  );
  if (!plan.projection) {
    const budgetExhausted = plan.omissions.some(
      (item) => item.reason === "global_budget"
    );
    throw new ContextCapsuleContractError(
      budgetExhausted ? "invalid_budget" : "no_evidence",
      budgetExhausted
        ? "No evidence fit the requested Context Capsule budget"
        : "No in-scope evidence was available for the Context Capsule"
    );
  }
  const traceResult = await deps.traceSession?.recordContext(
    plan.projection.value
  );
  if (traceResult && !traceResult.ok) {
    throw new ContextRuntimeError(
      "retrieval_failed",
      `Trace recording failed: ${traceResult.error.message}`,
      traceResult.error.cause
    );
  }
  if (plan.explain) {
    Object.defineProperty(
      plan.projection.value,
      CONTEXT_CAPSULE_EXPLAIN_METADATA,
      {
        configurable: true,
        enumerable: false,
        value: plan.explain,
      }
    );
  }
  return plan.projection.value;
};

/** Verify one Capsule through the same runtime fingerprint boundary. */
export const verifyContextCapsuleRuntime = async (
  input: unknown,
  deps: ContextCapsuleRuntimeDeps
): Promise<ContextCapsuleVerification> => {
  // Parse before any store access. verifyContextCapsule repeats this guard to
  // retain its standalone fail-closed contract.
  const capsule = parseCanonicalContextCapsuleForVerification(input, {
    countTokens: deps.countTokens,
    tokenizerFingerprint: deps.tokenizerFingerprint,
  });
  if (
    deps.indexName !== undefined &&
    canonicalizeIndexName(deps.indexName) !== capsule.scope.indexName
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      `Context Capsule index ${capsule.scope.indexName} does not match runtime index ${deps.indexName}`
    );
  }
  return verifyContextCapsule(input, {
    store: deps.store,
    currentFingerprints: currentContextFingerprints(capsule, deps),
    resolveCurrentRanks: deps.resolveCurrentRanks,
    countTokens: deps.countTokens,
    tokenizerFingerprint: deps.tokenizerFingerprint,
  });
};

export const canonicalBuiltContextCapsuleJson = (
  capsule: ContextCapsuleV1
): string => canonicalContextCapsuleJson(capsule);

export const canonicalVerifiedContextCapsuleJson = (
  receipt: ContextCapsuleVerification
): string => canonicalContextCapsuleVerificationJson(receipt);

/** Pure validation used by CLI before opening the selected store. */
export const validateContextCapsuleBuildInput = (
  input: ContextCapsuleBuildInput,
  defaultIndexName?: string,
  configuredCollectionNames?: readonly string[]
): void => {
  normalizeContextBuildInput(
    input,
    defaultIndexName,
    new Date(),
    configuredCollectionNames
  );
};
