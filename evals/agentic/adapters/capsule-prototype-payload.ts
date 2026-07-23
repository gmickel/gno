import type {
  ContextAgentProjection,
  ContextAgentProjectionSource,
} from "../../../src/app/context-agent-projection";
import type {
  CapsuleCandidate,
  CapsuleOmission,
  CapsuleSelection,
} from "../capsule-selection";
import type { NormalizedToolEvidence, NormalizedToolResult } from "../types";

import { formatContextAgentProjectionJson } from "../../../src/app/context-agent-projection";
import {
  canonicalJson,
  modelVisibleUtf8Bytes,
  projectModelVisibleToolResult,
  sha256Bytes,
} from "../canonical";

export type CapsulePrototypePayload = ContextAgentProjection;

export interface CapsulePayloadContext {
  taskId: string;
  goal: string;
  query: string;
  variants: readonly string[];
  facets: readonly string[];
  backendInvocations: number;
  backendInvocationStages: {
    queryPlanning: number;
    lexicalSearch: number;
    sourceRead: number;
    selection: number;
    finalization: number;
  };
  indexFingerprint: string;
  configFingerprint: string;
  maxModelVisibleUtf8Bytes: number;
}

const normalizedEvidence = (
  evidence: readonly CapsuleCandidate[]
): NormalizedToolEvidence[] =>
  evidence.map(({ retrievalRank: _rank, facets: _facets, ...item }) => item);

const allReasonCounts = (
  omitted: readonly CapsuleOmission[]
): Record<string, number> => ({
  duplicate: omitted.filter((item) => item.reason === "duplicate").length,
  overlap: omitted.filter((item) => item.reason === "overlap").length,
  global_budget: omitted.filter((item) => item.reason === "global_budget")
    .length,
  redundant_coverage: omitted.filter(
    (item) => item.reason === "redundant_coverage"
  ).length,
  document_share_cap: 0,
  filtered_by_scope: 0,
  invalid_coordinates: 0,
});

const projectionSource = (
  context: CapsulePayloadContext,
  selection: CapsuleSelection,
  conservativeOmissions?: readonly CapsuleOmission[]
): ContextAgentProjectionSource => {
  const covered = new Set(selection.evidence.flatMap((item) => item.facets));
  const omitted = conservativeOmissions ?? selection.omitted;
  return {
    capsuleId: sha256Bytes(
      canonicalJson({
        taskId: context.taskId,
        query: context.query,
        evidence: selection.evidence.map((item) => item.spanHash),
      })
    ),
    goal: context.goal,
    query: context.query,
    budget: {
      requestedTokens: Math.max(
        1,
        Math.floor(context.maxModelVisibleUtf8Bytes / 4)
      ),
      requestedBytes: context.maxModelVisibleUtf8Bytes,
      usedTokens: null,
      usedBytes: null,
      estimator: "model_visible_utf8",
      tokenizerFingerprint: null,
    },
    retrieval: {
      depthPolicy: "fast",
      indexFingerprint: context.indexFingerprint,
      configFingerprint: context.configFingerprint,
      retrievalFingerprint: sha256Bytes(
        canonicalJson({
          variants: context.variants,
          stages: context.backendInvocationStages,
        })
      ),
      embeddingModelFingerprint: null,
      rerankModelFingerprint: null,
      capabilities: {
        lexicalSearch: true,
        semanticSearch: false,
        reranking: false,
        graphExpansion: false,
        exactTokenCount: false,
        configuredContext: false,
        egressPolicy: false,
      },
      fallbacks: [],
    },
    guidance: {
      evidenceTrust: "untrusted_data",
      instructionBoundary: "hard_delimited",
      configuredContexts: [],
    },
    evidence: selection.evidence.map((item) => ({
      uri: item.uri,
      title: null,
      heading: null,
      sourceHash: item.sourceHash,
      mirrorHash: item.sourceHash,
      startLine: item.startLine,
      endLine: item.endLine,
      passageHash: item.spanHash,
      contextIds: [],
      egress: "unavailable",
      text: item.text,
    })),
    coverage: {
      requestedFacets: context.facets,
      coveredFacets: context.facets.filter((facet) => covered.has(facet)),
      unresolvedFacets: context.facets.filter((facet) => !covered.has(facet)),
      gaps: context.facets
        .filter((facet) => !covered.has(facet))
        .map((facet) => ({ facet, code: "facet_not_found" })),
    },
    omissions: {
      total: omitted.length,
      reasonCounts: allReasonCounts(omitted),
      items: omitted.map((item) => ({
        uri: item.uri,
        sourceHash: item.sourceHash,
        startLine: item.startLine,
        endLine: item.endLine,
        passageHash: item.spanHash,
        reason: item.reason,
      })),
    },
    truncated: omitted.some((item) => item.reason === "global_budget"),
  };
};

const resultForSource = (
  source: ContextAgentProjectionSource,
  evidence: readonly CapsuleCandidate[]
): NormalizedToolResult => ({
  status: "ok",
  resultRole: "evidence_bundle",
  content: formatContextAgentProjectionJson(source),
  evidence: normalizedEvidence(evidence),
  errorCode: null,
});

export const conservativeCapsuleResultFits = (
  context: CapsulePayloadContext,
  evidence: readonly CapsuleCandidate[],
  allCandidates: readonly CapsuleCandidate[]
): boolean => {
  const conservativeOmissions = allCandidates.map((candidate) => ({
    uri: candidate.uri,
    sourceHash: candidate.sourceHash,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    spanHash: candidate.spanHash,
    reason: "redundant_coverage" as const,
  }));
  const source = projectionSource(
    context,
    { evidence: [...evidence], omitted: [] },
    conservativeOmissions
  );
  return (
    modelVisibleUtf8Bytes(
      projectModelVisibleToolResult(resultForSource(source, evidence))
    ) <= context.maxModelVisibleUtf8Bytes
  );
};

export const finalizeCapsuleResult = (
  context: CapsulePayloadContext,
  selection: CapsuleSelection
): { payload: CapsulePrototypePayload; result: NormalizedToolResult } => {
  const source = projectionSource(context, selection);
  const result = resultForSource(source, selection.evidence);
  const finalBytes = modelVisibleUtf8Bytes(
    projectModelVisibleToolResult(result)
  );
  if (finalBytes > context.maxModelVisibleUtf8Bytes) {
    throw new Error(
      `Capsule result exceeds its global model-visible byte budget: ${finalBytes}`
    );
  }
  return {
    payload: JSON.parse(result.content) as CapsulePrototypePayload,
    result,
  };
};

export const canonicalCapsulePayloadJson = (
  payload: CapsulePrototypePayload
): string => canonicalJson(payload);

export const capsulePayloadFingerprint = (
  payload: CapsulePrototypePayload | string
): string =>
  sha256Bytes(typeof payload === "string" ? payload : canonicalJson(payload));
