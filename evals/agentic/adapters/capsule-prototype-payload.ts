import type {
  CapsuleCandidate,
  CapsuleOmission,
  CapsuleSelection,
} from "../capsule-selection";
import type { NormalizedToolEvidence, NormalizedToolResult } from "../types";

import {
  canonicalJson,
  modelVisibleUtf8Bytes,
  projectModelVisibleToolResult,
  sha256Bytes,
} from "../canonical";

export const CAPSULE_PROTOTYPE_SCHEMA_VERSION =
  "eval-capsule-prototype-v1" as const;

interface CapsulePayloadEvidence {
  uri: string;
  sourceHash: string;
  startLine: number;
  endLine: number;
  spanHash: string;
  text: string;
}

export interface CapsulePrototypePayload {
  schemaVersion: typeof CAPSULE_PROTOTYPE_SCHEMA_VERSION;
  evalOnly: true;
  taskId: string;
  goal: string;
  query: string;
  budget: {
    maxModelVisibleUtf8Bytes: number;
    selectedModelVisibleUtf8Bytes: number;
  };
  retrieval: {
    variants: string[];
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
  };
  coverage: {
    coveredFacets: string[];
    unresolvedFacets: string[];
  };
  evidence: CapsulePayloadEvidence[];
  omitted: {
    candidates: CapsuleOmission[];
    counts: {
      duplicate: number;
      overlap: number;
      globalBudget: number;
      redundantCoverage: number;
    };
  };
}

export interface CapsulePayloadContext {
  taskId: string;
  goal: string;
  query: string;
  variants: readonly string[];
  facets: readonly string[];
  backendInvocations: number;
  backendInvocationStages: CapsulePrototypePayload["retrieval"]["backendInvocationStages"];
  indexFingerprint: string;
  configFingerprint: string;
  maxModelVisibleUtf8Bytes: number;
}

const payloadEvidence = (
  evidence: readonly CapsuleCandidate[]
): CapsulePayloadEvidence[] =>
  evidence.map((item) => ({
    uri: item.uri,
    sourceHash: item.sourceHash,
    startLine: item.startLine,
    endLine: item.endLine,
    spanHash: item.spanHash,
    text: item.text,
  }));

const normalizedEvidence = (
  evidence: readonly CapsuleCandidate[]
): NormalizedToolEvidence[] =>
  evidence.map(({ retrievalRank: _rank, facets: _facets, ...item }) => item);

const omissionCounts = (
  selection: CapsuleSelection
): CapsulePrototypePayload["omitted"]["counts"] => ({
  duplicate: selection.omitted.filter((item) => item.reason === "duplicate")
    .length,
  overlap: selection.omitted.filter((item) => item.reason === "overlap").length,
  globalBudget: selection.omitted.filter(
    (item) => item.reason === "global_budget"
  ).length,
  redundantCoverage: selection.omitted.filter(
    (item) => item.reason === "redundant_coverage"
  ).length,
});

const buildPayload = (
  context: CapsulePayloadContext,
  selection: CapsuleSelection,
  selectedModelVisibleUtf8Bytes: number,
  conservativeOmissions?: readonly CapsuleOmission[]
): CapsulePrototypePayload => {
  const covered = new Set(selection.evidence.flatMap((item) => item.facets));
  const omittedCandidates = conservativeOmissions
    ? [...conservativeOmissions]
    : [...selection.omitted];
  return {
    schemaVersion: CAPSULE_PROTOTYPE_SCHEMA_VERSION,
    evalOnly: true,
    taskId: context.taskId,
    goal: context.goal,
    query: context.query,
    budget: {
      maxModelVisibleUtf8Bytes: context.maxModelVisibleUtf8Bytes,
      selectedModelVisibleUtf8Bytes,
    },
    retrieval: {
      variants: [...context.variants],
      backendInvocations: context.backendInvocations,
      backendInvocationStages: context.backendInvocationStages,
      indexFingerprint: context.indexFingerprint,
      configFingerprint: context.configFingerprint,
    },
    coverage: {
      coveredFacets: context.facets.filter((facet) => covered.has(facet)),
      unresolvedFacets: context.facets.filter((facet) => !covered.has(facet)),
    },
    evidence: payloadEvidence(selection.evidence),
    omitted: {
      candidates: omittedCandidates,
      counts: omissionCounts({
        ...selection,
        omitted: omittedCandidates,
      }),
    },
  };
};

const resultForPayload = (
  payload: CapsulePrototypePayload,
  evidence: readonly CapsuleCandidate[]
): NormalizedToolResult => ({
  status: "ok",
  resultRole: "evidence_bundle",
  content: canonicalJson(payload),
  evidence: normalizedEvidence(evidence),
  errorCode: null,
});

export const conservativeCapsuleResultFits = (
  context: CapsulePayloadContext,
  evidence: readonly CapsuleCandidate[],
  allCandidates: readonly CapsuleCandidate[]
): boolean => {
  const selection = { evidence: [...evidence], omitted: [] };
  const conservativeOmissions = allCandidates.map((candidate) => ({
    uri: candidate.uri,
    sourceHash: candidate.sourceHash,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    spanHash: candidate.spanHash,
    reason: "redundant_coverage" as const,
  }));
  const payload = buildPayload(
    context,
    selection,
    context.maxModelVisibleUtf8Bytes,
    conservativeOmissions
  );
  return (
    modelVisibleUtf8Bytes(
      projectModelVisibleToolResult(resultForPayload(payload, evidence))
    ) <= context.maxModelVisibleUtf8Bytes
  );
};

export const finalizeCapsuleResult = (
  context: CapsulePayloadContext,
  selection: CapsuleSelection
): { payload: CapsulePrototypePayload; result: NormalizedToolResult } => {
  let used = context.maxModelVisibleUtf8Bytes;
  let payload = buildPayload(context, selection, used);
  let result = resultForPayload(payload, selection.evidence);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const measured = modelVisibleUtf8Bytes(
      projectModelVisibleToolResult(result)
    );
    if (measured === used) break;
    used = measured;
    payload = buildPayload(context, selection, used);
    result = resultForPayload(payload, selection.evidence);
  }
  const finalBytes = modelVisibleUtf8Bytes(
    projectModelVisibleToolResult(result)
  );
  if (finalBytes > context.maxModelVisibleUtf8Bytes) {
    throw new Error(
      `Capsule result exceeds its global model-visible byte budget: ${finalBytes}`
    );
  }
  return { payload, result };
};

export const canonicalCapsulePayloadJson = (
  payload: CapsulePrototypePayload
): string => canonicalJson(payload);

export const capsulePayloadFingerprint = (
  payload: CapsulePrototypePayload | string
): string =>
  sha256Bytes(
    typeof payload === "string" ? payload : canonicalCapsulePayloadJson(payload)
  );
