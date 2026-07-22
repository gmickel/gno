import type {
  AgentTask,
  BenchmarkScoreRecord,
  ClaimValue,
  EvidenceCoordinate,
  FinalEnvelope,
  HiddenOracle,
  NormalizerId,
  TaskScore,
  TrajectoryReceipt,
} from "./types";

import { canonicalJson, evidenceKey } from "./canonical";
import {
  assertAgenticSchema,
  validateFinalEnvelopeSemantics,
  validateTrajectoryAccounting,
} from "./validation";

export interface ScoredReceipt {
  receipt: TrajectoryReceipt;
  score: BenchmarkScoreRecord;
}

export const scoreRecordFor = (
  receipt: TrajectoryReceipt,
  score: TaskScore
): BenchmarkScoreRecord => ({
  taskId: receipt.canonical.taskId,
  adapterId: receipt.canonical.adapterId,
  trialId: receipt.canonical.trialId,
  seed: receipt.canonical.seed,
  lifecycle: receipt.canonical.lifecycle,
  agentId: receipt.canonical.agentId,
  score,
});

const normalizeScalar = (
  value: string | number | boolean,
  normalizer: NormalizerId
): string | number | boolean => {
  if (typeof value !== "string") return value;
  if (normalizer === "trim-lower-v1") return value.trim().toLowerCase();
  if (normalizer === "identifier-v1") {
    return value.trim().toUpperCase().replace(/\s+/g, "");
  }
  if (normalizer === "iso-date-v1") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp)
      ? value
      : new Date(timestamp).toISOString().slice(0, 10);
  }
  return value;
};

const normalizeClaimValue = (
  value: ClaimValue,
  normalizer: NormalizerId
): unknown => {
  if (value.type === "string[]") {
    const normalized = value.value.map((item) =>
      String(normalizeScalar(item, normalizer))
    );
    return normalizer === "string-set-v1" ? [...normalized].sort() : normalized;
  }
  return normalizeScalar(value.value, normalizer);
};

const claimValuesEqual = (
  actual: ClaimValue,
  expected: ClaimValue,
  normalizer: NormalizerId
): boolean =>
  actual.type === expected.type &&
  canonicalJson(normalizeClaimValue(actual, normalizer)) ===
    canonicalJson(normalizeClaimValue(expected, normalizer));

const containsAllEvidence = (
  actual: EvidenceCoordinate[],
  expected: EvidenceCoordinate[]
): boolean => {
  const keys = new Set(actual.map(evidenceKey));
  return expected.every((coordinate) => keys.has(evidenceKey(coordinate)));
};

const containsAnyEvidence = (
  actual: EvidenceCoordinate[],
  expected: EvidenceCoordinate[]
): boolean => {
  const keys = new Set(actual.map(evidenceKey));
  return expected.some((coordinate) => keys.has(evidenceKey(coordinate)));
};

const getNestedValue = (
  value: Record<string, unknown>,
  path: string
): unknown => {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const scopeScores = (
  oracle: HiddenOracle,
  receipt: TrajectoryReceipt
): { collectionCorrect: boolean; filtersCorrect: boolean } => {
  const calls = receipt.canonical.calls;
  const collectionCorrect =
    oracle.expectedScope.collection === null ||
    calls.some(
      (call) =>
        getNestedValue(call.arguments, "collection") ===
        oracle.expectedScope.collection
    );
  const filterEntries = Object.entries(oracle.expectedScope.filters);
  const filtersCorrect =
    filterEntries.length === 0 ||
    calls.some((call) =>
      filterEntries.every(([key, expected]) => {
        const direct = getNestedValue(call.arguments, key);
        const nested = getNestedValue(call.arguments, `filters.${key}`);
        return direct === expected || nested === expected;
      })
    );
  return { collectionCorrect, filtersCorrect };
};

const returnedEvidence = (receipt: TrajectoryReceipt): EvidenceCoordinate[] =>
  receipt.canonical.calls
    .filter((call) => call.deliveredToAgent)
    .flatMap((call) => call.result.evidence);

const invalidScore = (
  task: AgentTask,
  reason: string,
  scored = true
): TaskScore => ({
  taskId: task.taskId,
  scored,
  exclusionReason: scored ? null : reason,
  success: 0,
  completed: false,
  supportedClaims: [],
  unsupportedClaims: [],
  missingRequiredClaims: task.claims
    .filter((claim) => claim.required)
    .map((claim) => claim.claimKey),
  forbiddenEvidenceClaims: [],
  invalidOutputs: scored ? [reason] : [],
  correctAbstention: false,
  prematureStop: false,
  unnecessaryRead: false,
  collectionCorrect: false,
  filtersCorrect: false,
  substantiveClaims: 0,
  linkedSupportedClaims: 0,
});

export const scoreTrajectory = (
  task: AgentTask,
  oracle: HiddenOracle,
  receipt: TrajectoryReceipt,
  rawFinalEnvelope: unknown = receipt.canonical.finalEnvelope
): TaskScore => {
  assertAgenticSchema("agent-task", task);
  assertAgenticSchema("hidden-oracle", oracle);
  assertAgenticSchema("trajectory-receipt", receipt);
  if (
    task.taskId !== oracle.taskId ||
    task.taskId !== receipt.canonical.taskId
  ) {
    return invalidScore(task, "task_identity_mismatch");
  }
  if (receipt.canonical.failure.class === "harness_error") {
    return invalidScore(task, "harness_error", false);
  }
  try {
    assertAgenticSchema("final-envelope", rawFinalEnvelope);
  } catch (error) {
    return invalidScore(
      task,
      `invalid_final_envelope:${(error as Error).message}`
    );
  }
  const envelope = rawFinalEnvelope as FinalEnvelope;
  const semanticIssues = validateFinalEnvelopeSemantics(task, envelope);
  const invalidOutputs = [
    ...semanticIssues.map((issue) => `${issue.code}:${issue.claimKey}`),
    ...validateTrajectoryAccounting(receipt),
  ];
  const supportedClaims: string[] = [];
  const unsupportedClaims: string[] = [];
  const forbiddenEvidenceClaims: string[] = [];
  const missingRequiredClaims: string[] = [];
  let linkedSupportedClaims = 0;
  let substantiveClaims = 0;

  const publicDefinitions = new Map(
    task.claims.map((definition) => [definition.claimKey, definition])
  );
  const actualClaims = new Map(
    envelope.claims.map((claim) => [claim.claimKey, claim])
  );
  const observedEvidence = returnedEvidence(receipt);
  for (const oracleClaim of oracle.claims) {
    const definition = publicDefinitions.get(oracleClaim.claimKey);
    const actual = actualClaims.get(oracleClaim.claimKey);
    if (!definition || !actual) {
      if (definition?.required)
        missingRequiredClaims.push(oracleClaim.claimKey);
      continue;
    }
    if (definition.substantive) substantiveClaims += 1;
    const valueCorrect = claimValuesEqual(
      actual.value,
      oracleClaim.expectedValue,
      oracleClaim.normalizer.id
    );
    const evidenceComplete = containsAllEvidence(
      actual.citations,
      oracleClaim.requiredEvidence
    );
    const citationsObserved = containsAllEvidence(
      observedEvidence,
      actual.citations
    );
    const forbidden = containsAnyEvidence(
      actual.citations,
      oracleClaim.forbiddenEvidence
    );
    if (forbidden) forbiddenEvidenceClaims.push(oracleClaim.claimKey);
    if (valueCorrect && evidenceComplete && citationsObserved && !forbidden) {
      supportedClaims.push(oracleClaim.claimKey);
      if (definition.substantive && actual.citations.length > 0) {
        linkedSupportedClaims += 1;
      }
    } else {
      unsupportedClaims.push(oracleClaim.claimKey);
    }
  }

  for (const definition of task.claims) {
    if (
      definition.required &&
      !actualClaims.has(definition.claimKey) &&
      !missingRequiredClaims.includes(definition.claimKey)
    ) {
      missingRequiredClaims.push(definition.claimKey);
    }
  }

  const missingGapKeys = new Set(
    envelope.gaps
      .filter((gap) => gap.reason === "missing_evidence")
      .map((gap) => gap.claimKey)
  );
  const correctAbstention =
    oracle.completion.expectAbstention &&
    envelope.abstained &&
    envelope.stopReason === "abstained" &&
    envelope.claims.length === 0 &&
    invalidOutputs.length === 0 &&
    unsupportedClaims.length === 0 &&
    forbiddenEvidenceClaims.length === 0 &&
    oracle.expectedMissing.every((claimKey) => missingGapKeys.has(claimKey));
  const { collectionCorrect, filtersCorrect } = scopeScores(oracle, receipt);

  const allExpectedEvidence = new Set(
    oracle.claims.flatMap((claim) => [
      ...claim.requiredEvidence.map(evidenceKey),
      ...claim.optionalEvidence.map(evidenceKey),
      ...claim.forbiddenEvidence.map(evidenceKey),
    ])
  );
  const hasUnexpectedEvidence = returnedEvidence(receipt).some(
    (coordinate) => !allExpectedEvidence.has(evidenceKey(coordinate))
  );
  const unnecessaryRead =
    receipt.canonical.agentCalls > oracle.completion.maxAgentCalls ||
    receipt.canonical.modelVisibleUtf8Bytes >
      oracle.completion.maxModelVisibleBytes ||
    (oracle.completion.failOnUnexpectedEvidence && hasUnexpectedEvidence);
  const evidenceFailure =
    unsupportedClaims.length > 0 ||
    missingRequiredClaims.length > 0 ||
    forbiddenEvidenceClaims.length > 0;
  const prematureStop =
    envelope.stopReason === "complete" &&
    (evidenceFailure || invalidOutputs.length > 0);
  const completed = oracle.completion.expectAbstention
    ? correctAbstention
    : envelope.stopReason === "complete" &&
      !envelope.abstained &&
      !evidenceFailure &&
      invalidOutputs.length === 0;
  const success =
    completed &&
    !unnecessaryRead &&
    collectionCorrect &&
    filtersCorrect &&
    receipt.canonical.failure.class === "none"
      ? 1
      : 0;

  return {
    taskId: task.taskId,
    scored: true,
    exclusionReason: null,
    success,
    completed,
    supportedClaims,
    unsupportedClaims,
    missingRequiredClaims,
    forbiddenEvidenceClaims,
    invalidOutputs,
    correctAbstention,
    prematureStop,
    unnecessaryRead,
    collectionCorrect,
    filtersCorrect,
    substantiveClaims,
    linkedSupportedClaims,
  };
};
