import type { RefinementCtx } from "zod";

import type { ContextCapsulePayloadV1 } from "./context-capsule-schema";

import { DEFAULT_INDEX_NAME, parseUri } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";

export const sha256Text = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const contextCapsuleContextIdentity = (value: {
  scopeType: "global" | "collection" | "prefix";
  scopeKey: string;
  text: string;
}): string =>
  sha256Text(
    JSON.stringify({
      scopeKey: value.scopeKey,
      scopeType: value.scopeType,
      text: value.text,
    })
  );

export const contextCapsuleEvidenceIdentity = (value: {
  uri: string;
  docid: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  mirrorHash: string;
  passageHash: string;
}): string =>
  sha256Text(
    JSON.stringify({
      docid: value.docid,
      endLine: value.endLine,
      mirrorHash: value.mirrorHash,
      passageHash: value.passageHash,
      sourceHash: value.sourceHash,
      startLine: value.startLine,
      uri: value.uri,
    })
  );

export const contextCapsuleOmissionIdentity = (value: {
  uri: string;
  docid: string;
  startLine: number | null;
  endLine: number | null;
  passageHash: string | null;
  sourceHash: string;
  mirrorHash: string;
}): string =>
  sha256Text(
    JSON.stringify({
      docid: value.docid,
      endLine: value.endLine,
      mirrorHash: value.mirrorHash,
      passageHash: value.passageHash,
      sourceHash: value.sourceHash,
      startLine: value.startLine,
      uri: value.uri,
    })
  );

const unique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

const sameValues = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const uriIndex = (indexName?: string): string =>
  canonicalizeIndexName(indexName ?? DEFAULT_INDEX_NAME);

const isWithinPrefix = (
  uri: NonNullable<ReturnType<typeof parseUri>>,
  prefix: NonNullable<ReturnType<typeof parseUri>>
): boolean =>
  uri.collection === prefix.collection &&
  uriIndex(uri.indexName) === uriIndex(prefix.indexName) &&
  (uri.path === prefix.path || uri.path.startsWith(`${prefix.path}/`));

const validateCapabilityBindings = (
  value: ContextCapsulePayloadV1,
  fallbackKeys: Set<string>,
  context: RefinementCtx
): void => {
  const bindings = [
    ["semanticSearch", "embedding_unavailable", "embeddingModel"],
    ["reranking", "reranking_unavailable", "rerankModel"],
    ["graphExpansion", "graph_unavailable", null],
    ["egressPolicy", "egress_policy_unavailable", null],
  ] as const;
  const expectedFallbackCapabilities = new Map([
    ["embedding_unavailable", "semantic_search"],
    ["reranking_unavailable", "reranking"],
    ["graph_unavailable", "graph_expansion"],
    ["tokenizer_unavailable", "token_count"],
    ["egress_policy_unavailable", "egress_policy"],
  ]);
  if (
    !unique(value.fallbacks.map((item) => item.code)) ||
    value.fallbacks.some(
      (item) => expectedFallbackCapabilities.get(item.code) !== item.capability
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid or duplicate fallback binding",
      path: ["fallbacks"],
    });
  }
  for (const [capability, fallback, fingerprint] of bindings) {
    const available = value.capabilities[capability];
    if (fallbackKeys.has(fallback) === available) {
      context.addIssue({
        code: "custom",
        message: `${fallback} must be present exactly when ${capability} is unavailable`,
        path: ["fallbacks"],
      });
    }
    if (
      fingerprint &&
      (value.fingerprints[fingerprint] !== null) !== available
    ) {
      context.addIssue({
        code: "custom",
        message: `${fingerprint} must be present exactly when ${capability} is available`,
        path: ["fingerprints", fingerprint],
      });
    }
  }
  if (value.fingerprints.tokenizer !== value.budget.tokenizerFingerprint) {
    context.addIssue({
      code: "custom",
      message: "tokenizer fingerprints disagree",
      path: ["fingerprints", "tokenizer"],
    });
  }
};

const validateCoverageBindings = (
  value: ContextCapsulePayloadV1,
  context: RefinementCtx
): void => {
  const requested = new Set(value.coverage.requestedFacets);
  const covered = value.coverage.coveredFacets.map((item) => item.facet);
  const unresolved = value.coverage.unresolvedFacets;
  const evidenceById = new Map(
    value.evidence.map((item) => [item.evidenceId, item])
  );
  const contextsById = new Map(
    value.guidance.configuredContexts.map((item) => [item.contextId, item])
  );
  const partitions = [...covered, ...unresolved];
  if (!sameValues(value.retrieval.facets, value.coverage.requestedFacets)) {
    context.addIssue({
      code: "custom",
      message: "retrieval facets must exactly match requested coverage facets",
      path: ["retrieval", "facets"],
    });
  }
  if (
    !unique(value.coverage.requestedFacets) ||
    !unique(covered) ||
    !unique(unresolved) ||
    partitions.length !== requested.size ||
    partitions.some((facet) => !requested.has(facet))
  ) {
    context.addIssue({
      code: "custom",
      message:
        "covered and unresolved facets must uniquely partition requested facets",
      path: ["coverage"],
    });
  }
  if (!unique(value.evidence.map((item) => item.evidenceId))) {
    context.addIssue({
      code: "custom",
      message: "duplicate evidenceId",
      path: ["evidence"],
    });
  }
  const configuredContextsValid =
    unique(value.guidance.configuredContexts.map((item) => item.contextId)) &&
    value.guidance.configuredContexts.every(
      (item) => contextCapsuleContextIdentity(item) === item.contextId
    );
  if (!configuredContextsValid) {
    context.addIssue({
      code: "custom",
      message: "configured context IDs must be unique and content-bound",
      path: ["guidance", "configuredContexts"],
    });
  }
  for (const [index, evidence] of value.evidence.entries()) {
    const parsedUri = parseUri(evidence.uri);
    const prefix =
      value.scope.uriPrefix === null ? null : parseUri(value.scope.uriPrefix);
    const inScope =
      parsedUri !== null &&
      evidence.collection === parsedUri.collection &&
      uriIndex(parsedUri.indexName) ===
        canonicalizeIndexName(value.scope.indexName) &&
      (value.scope.collections.length === 0 ||
        value.scope.collections.includes(parsedUri.collection)) &&
      (prefix === null || isWithinPrefix(parsedUri, prefix));
    if (!inScope) {
      context.addIssue({
        code: "custom",
        message:
          "evidence URI, collection, index, and requested scope disagree",
        path: ["evidence", index, "uri"],
      });
    }
    if (evidence.selectionRank !== index + 1) {
      context.addIssue({
        code: "custom",
        message: "selectionRank must match deterministic evidence order",
        path: ["evidence", index, "selectionRank"],
      });
    }
    if (
      !unique(evidence.facets) ||
      evidence.facets.some((facet) => !requested.has(facet))
    ) {
      context.addIssue({
        code: "custom",
        message: "evidence facets must be unique requested facets",
        path: ["evidence", index, "facets"],
      });
    }
    const contextScopesApply = evidence.contextIds.every((contextId) => {
      const configured = contextsById.get(contextId);
      if (!configured || !parsedUri) return false;
      if (configured.scopeType === "global") return true;
      if (configured.scopeType === "collection") {
        return configured.scopeKey === `${parsedUri.collection}:`;
      }
      const contextPrefix = parseUri(configured.scopeKey);
      return contextPrefix !== null && isWithinPrefix(parsedUri, contextPrefix);
    });
    if (!contextScopesApply) {
      context.addIssue({
        code: "custom",
        message: "evidence context references must apply to its URI scope",
        path: ["evidence", index, "contextIds"],
      });
    }
    if (
      !unique(evidence.contextIds) ||
      evidence.contextIds.some((contextId) => !contextsById.has(contextId))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "evidence context references must bind trusted configured guidance",
        path: ["evidence", index, "contextIds"],
      });
    }
  }
  if (!unique(value.retrieval.queryVariants)) {
    context.addIssue({
      code: "custom",
      message: "query variants must be unique while preserving plan order",
      path: ["retrieval", "queryVariants"],
    });
  }
  for (const [index, item] of value.coverage.coveredFacets.entries()) {
    const validReferences =
      unique(item.evidenceIds) &&
      item.evidenceIds.every((id) =>
        evidenceById.get(id)?.facets.includes(item.facet)
      );
    if (!validReferences) {
      context.addIssue({
        code: "custom",
        message:
          "covered facet references must bind evidence carrying that facet",
        path: ["coverage", "coveredFacets", index, "evidenceIds"],
      });
    }
  }
  const gapFacets = value.coverage.gaps.map((item) => item.facet);
  if (
    !unique(gapFacets) ||
    unresolved.some((facet) => !gapFacets.includes(facet)) ||
    gapFacets.some((facet) => !unresolved.includes(facet))
  ) {
    context.addIssue({
      code: "custom",
      message: "each unresolved facet requires exactly one gap",
      path: ["coverage", "gaps"],
    });
  }
  const complete = unresolved.length === 0 && value.coverage.gaps.length === 0;
  if (value.coverage.complete !== complete) {
    context.addIssue({
      code: "custom",
      message: "complete must reflect unresolved facets and gaps",
      path: ["coverage", "complete"],
    });
  }
};

export const validateContextCapsulePayload = (
  value: ContextCapsulePayloadV1,
  context: RefinementCtx
): void => {
  const fallbackKeys = new Set(value.fallbacks.map((item) => item.code));
  const exactTokenizer =
    value.budget.estimator === "active_tokenizer" &&
    value.budget.tokenizerFingerprint !== null &&
    value.capabilities.exactTokenCount &&
    !fallbackKeys.has("tokenizer_unavailable");
  const fallbackTokenizer =
    value.budget.estimator === "unicode_conservative" &&
    value.budget.tokenizerFingerprint === null &&
    !value.capabilities.exactTokenCount &&
    fallbackKeys.has("tokenizer_unavailable");
  if (!(exactTokenizer || fallbackTokenizer)) {
    context.addIssue({
      code: "custom",
      message:
        "token estimator authority, capability, fingerprint, and fallback disagree",
      path: ["budget", "estimator"],
    });
  }
  validateCapabilityBindings(value, fallbackKeys, context);
  validateCoverageBindings(value, context);
  const warningKeys = value.warnings.map((item) => item.code);
  const warningSet = new Set(warningKeys);
  if (!unique(warningKeys)) {
    context.addIssue({
      code: "custom",
      message: "warning codes must be unique",
      path: ["warnings"],
    });
  }
  const expectedWarnings = new Set<string>();
  if (!value.coverage.complete) expectedWarnings.add("incomplete_coverage");
  if (value.omissions.truncated) expectedWarnings.add("omissions_truncated");
  if (fallbackTokenizer) expectedWarnings.add("token_estimate_used");
  if (
    warningSet.size !== expectedWarnings.size ||
    [...warningSet].some((warning) => !expectedWarnings.has(warning))
  ) {
    context.addIssue({
      code: "custom",
      message: "warnings must exactly describe deterministic fallback state",
      path: ["warnings"],
    });
  }
  if (
    (!value.capabilities.egressPolicy &&
      value.evidence.some((item) => item.egress !== "unavailable")) ||
    (value.capabilities.egressPolicy &&
      value.evidence.some((item) => item.egress === "unavailable"))
  ) {
    context.addIssue({
      code: "custom",
      message: "evidence egress classification must match policy availability",
      path: ["evidence"],
    });
  }
  const hasGlobalBudget = value.omissions.items.some(
    (item) => item.reason === "global_budget"
  );
  if (value.truncated !== (value.omissions.truncated || hasGlobalBudget)) {
    context.addIssue({
      code: "custom",
      message: "truncated must reflect bounded or budget-omitted candidates",
      path: ["truncated"],
    });
  }
};
