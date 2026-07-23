/** Versioned, deterministic model-visible projection for Context Capsules. */

import type { ContextCapsuleV1 } from "../core/context-capsule";

export const CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION =
  "gno-context-agent-v1" as const;
export const CONTEXT_AGENT_OMISSION_ITEM_LIMIT = 1;

export interface ContextAgentProjectionEvidence {
  uri: string;
  sourceHash: string;
  mirrorHash: string;
  startLine: number;
  endLine: number;
  passageHash: string;
  text: string;
}

export interface ContextAgentProjectionOmission {
  uri: string;
  sourceHash: string;
  startLine: number | null;
  endLine: number | null;
  passageHash: string | null;
  reason: string;
}

export interface ContextAgentProjectionSource {
  capsuleId: string;
  goal: string;
  query: string;
  budget: {
    requestedTokens: number;
    requestedBytes: number;
    usedTokens: number | null;
    usedBytes: number | null;
    estimator: string;
  };
  retrieval: {
    depthPolicy: string;
    indexFingerprint: string;
    configFingerprint: string;
    retrievalFingerprint: string;
    embeddingModelFingerprint: string | null;
    rerankModelFingerprint: string | null;
    capabilities: {
      lexicalSearch: boolean;
      semanticSearch: boolean;
      reranking: boolean;
      graphExpansion: boolean;
      exactTokenCount: boolean;
      configuredContext: boolean;
      egressPolicy: boolean;
    };
    fallbacks: readonly string[];
  };
  evidence: readonly ContextAgentProjectionEvidence[];
  coverage: {
    requestedFacets: readonly string[];
    coveredFacets: readonly string[];
    unresolvedFacets: readonly string[];
    gaps: readonly { facet: string; code: string }[];
  };
  omissions: {
    total: number;
    reasonCounts: Readonly<Record<string, number>>;
    items: readonly ContextAgentProjectionOmission[];
  };
  truncated: boolean;
}

export interface ContextAgentProjection extends ContextAgentProjectionSource {
  schemaVersion: typeof CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION;
  delivery: {
    modelVisibleUtf8Bytes: number;
    structuredContent: "full_capsule_application_payload";
    accounting: "mcp_text_content_only";
  };
  trust: {
    evidence: "untrusted_data";
    instructionBoundary: "hard_delimited";
  };
  omissions: ContextAgentProjectionSource["omissions"] & {
    visibleItemLimit: typeof CONTEXT_AGENT_OMISSION_ITEM_LIMIT;
    visibleItems: readonly ContextAgentProjectionOmission[];
    truncated: boolean;
  };
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      output[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const projectionWithBytes = (
  source: ContextAgentProjectionSource,
  modelVisibleUtf8Bytes: number
): ContextAgentProjection => ({
  ...source,
  schemaVersion: CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION,
  delivery: {
    modelVisibleUtf8Bytes,
    structuredContent: "full_capsule_application_payload",
    accounting: "mcp_text_content_only",
  },
  trust: {
    evidence: "untrusted_data",
    instructionBoundary: "hard_delimited",
  },
  omissions: {
    ...source.omissions,
    visibleItemLimit: CONTEXT_AGENT_OMISSION_ITEM_LIMIT,
    visibleItems: source.omissions.items.slice(
      0,
      CONTEXT_AGENT_OMISSION_ITEM_LIMIT
    ),
    truncated:
      source.omissions.total >
      Math.min(
        source.omissions.items.length,
        CONTEXT_AGENT_OMISSION_ITEM_LIMIT
      ),
  },
});

export const formatContextAgentProjectionJson = (
  source: ContextAgentProjectionSource
): string => {
  let measured = 0;
  let text = "";
  for (let iteration = 0; iteration < 8; iteration += 1) {
    text = canonicalJson(projectionWithBytes(source, measured));
    const next = utf8Bytes(text);
    if (next === measured) return text;
    measured = next;
  }
  return canonicalJson(projectionWithBytes(source, measured));
};

export const projectContextCapsuleForAgent = (
  capsule: ContextCapsuleV1
): ContextAgentProjectionSource => ({
  capsuleId: capsule.capsuleId,
  goal: capsule.goal,
  query: capsule.query,
  budget: {
    requestedTokens: capsule.budget.requestedTokens,
    requestedBytes: capsule.budget.requestedBytes,
    usedTokens: capsule.budget.usedTokens,
    usedBytes: capsule.budget.usedBytes,
    estimator: capsule.budget.estimator,
  },
  retrieval: {
    depthPolicy: capsule.retrieval.depthPolicy,
    indexFingerprint: capsule.retrieval.indexSnapshot.after,
    configFingerprint: capsule.fingerprints.config,
    retrievalFingerprint: capsule.fingerprints.retrieval,
    embeddingModelFingerprint: capsule.fingerprints.embeddingModel,
    rerankModelFingerprint: capsule.fingerprints.rerankModel,
    capabilities: capsule.capabilities,
    fallbacks: capsule.fallbacks.map(
      (fallback) => `${fallback.capability}:${fallback.code}`
    ),
  },
  evidence: capsule.evidence.map((item) => ({
    uri: item.uri,
    sourceHash: item.sourceHash,
    mirrorHash: item.mirrorHash,
    startLine: item.startLine,
    endLine: item.endLine,
    passageHash: item.passageHash,
    text: item.text,
  })),
  coverage: {
    requestedFacets: capsule.coverage.requestedFacets,
    coveredFacets: capsule.coverage.coveredFacets.map((item) => item.facet),
    unresolvedFacets: capsule.coverage.unresolvedFacets,
    gaps: capsule.coverage.gaps,
  },
  omissions: {
    total: capsule.omissions.total,
    reasonCounts: capsule.omissions.reasonCounts,
    items: capsule.omissions.items.map((item) => ({
      uri: item.uri,
      sourceHash: item.sourceHash,
      startLine: item.startLine,
      endLine: item.endLine,
      passageHash: item.passageHash,
      reason: item.reason,
    })),
  },
  truncated: capsule.truncated,
});

export const formatContextCapsuleAgentJson = (
  capsule: ContextCapsuleV1
): string =>
  formatContextAgentProjectionJson(projectContextCapsuleForAgent(capsule));
