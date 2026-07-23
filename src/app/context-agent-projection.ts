/** Versioned, deterministic model-visible projection for Context Capsules. */

import type { ContextCapsuleV1 } from "../core/context-capsule";

export const CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION =
  "gno-context-agent-v1" as const;

export interface ContextAgentProjectionEvidence {
  uri: string;
  title: string | null;
  heading: string | null;
  sourceHash: string;
  mirrorHash: string;
  startLine: number;
  endLine: number;
  passageHash: string;
  contextIds: readonly string[];
  egress: "local_only" | "lan" | "remote" | "unclassified" | "unavailable";
  text: string;
}

export interface ContextAgentProjectionGuidance {
  contextId: string;
  scopeType: "global" | "collection" | "prefix";
  scopeKey: string;
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
    tokenizerFingerprint: string | null;
  };
  guidance: {
    evidenceTrust: "untrusted_data";
    instructionBoundary: "hard_delimited";
    configuredContexts: readonly ContextAgentProjectionGuidance[];
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

type EvidenceTuple = readonly [
  uri: string,
  startLine: number,
  endLine: number,
  sourceHash: string,
  mirrorHash: string,
  passageHash: string,
  text: string,
  title: string | null,
  heading: string | null,
  contextIds: readonly string[],
  egress: ContextAgentProjectionEvidence["egress"],
];

type GuidanceTuple = readonly [
  contextId: string,
  scopeType: ContextAgentProjectionGuidance["scopeType"],
  scopeKey: string,
  text: string,
];

export interface ContextAgentProjection {
  /** Projection contract version. */
  v: typeof CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION;
  /** Capsule identity. */
  id: string;
  /** Tuple order: requested tokens/bytes, used tokens/bytes, estimator, tokenizer fingerprint. */
  b: readonly [
    number,
    number,
    number | null,
    number | null,
    string,
    string | null,
  ];
  /** Tuple order: depth; index/config/retrieval/embedding/rerank identities; capabilities; fallbacks. */
  r: readonly [
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    string[],
    readonly string[],
  ];
  /** Tuple order is declared by EvidenceTuple above and spec/mcp.md. */
  e: EvidenceTuple[];
  /** Tuple order: evidence trust, instruction boundary, configured guidance tuples. */
  g: readonly ["untrusted_data", "hard_delimited", GuidanceTuple[]];
  /** Tuple order: covered facets, then [facet, gap code] pairs. */
  c: readonly [
    readonly string[],
    Array<readonly [facet: string, code: string]>,
  ];
  /** Tuple order: total omissions, then sparse [reason, count] pairs. */
  o: readonly [number, Array<readonly [reason: string, count: number]>];
  /** True when the Capsule hit its global evidence budget. */
  t: boolean;
  trust: "untrusted_data";
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

const projection = (
  source: ContextAgentProjectionSource
): ContextAgentProjection => {
  const capabilities = Object.entries(source.retrieval.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([capability]) => capability);
  const reasonCounts = Object.entries(source.omissions.reasonCounts).filter(
    ([, count]) => count > 0
  );
  return {
    v: CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION,
    id: source.capsuleId,
    b: [
      source.budget.requestedTokens,
      source.budget.requestedBytes,
      source.budget.usedTokens,
      source.budget.usedBytes,
      source.budget.estimator,
      source.budget.tokenizerFingerprint,
    ],
    r: [
      source.retrieval.depthPolicy,
      source.retrieval.indexFingerprint,
      source.retrieval.configFingerprint,
      source.retrieval.retrievalFingerprint,
      source.retrieval.embeddingModelFingerprint,
      source.retrieval.rerankModelFingerprint,
      capabilities,
      source.retrieval.fallbacks,
    ],
    e: source.evidence.map((item) => [
      item.uri,
      item.startLine,
      item.endLine,
      item.sourceHash,
      item.mirrorHash,
      item.passageHash,
      item.text,
      item.title,
      item.heading,
      item.contextIds,
      item.egress,
    ]),
    g: [
      source.guidance.evidenceTrust,
      source.guidance.instructionBoundary,
      source.guidance.configuredContexts.map((context) => [
        context.contextId,
        context.scopeType,
        context.scopeKey,
        context.text,
      ]),
    ],
    c: [
      source.coverage.coveredFacets,
      source.coverage.gaps.map((gap) => [gap.facet, gap.code]),
    ],
    o: [source.omissions.total, reasonCounts],
    t: source.truncated,
    trust: "untrusted_data",
  };
};

export const formatContextAgentProjectionJson = (
  source: ContextAgentProjectionSource
): string => canonicalJson(projection(source));

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
    tokenizerFingerprint: capsule.budget.tokenizerFingerprint,
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
  guidance: {
    evidenceTrust: capsule.guidance.evidenceTrust,
    instructionBoundary: capsule.guidance.instructionBoundary,
    configuredContexts: capsule.guidance.configuredContexts,
  },
  evidence: capsule.evidence.map((item) => ({
    uri: item.uri,
    title: item.title,
    heading: item.heading,
    sourceHash: item.sourceHash,
    mirrorHash: item.mirrorHash,
    startLine: item.startLine,
    endLine: item.endLine,
    passageHash: item.passageHash,
    contextIds: item.contextIds,
    egress: item.egress,
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
