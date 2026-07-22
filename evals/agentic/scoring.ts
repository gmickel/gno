import type {
  AgentTask,
  ClaimValue,
  EvidenceCoordinate,
  FinalEnvelope,
  HiddenOracle,
  NormalizerId,
  PromotionGateResult,
  PromotionPair,
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
  score: TaskScore;
}

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
  receipt.canonical.calls.flatMap((call) => call.result.evidence);

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

const pairKey = (receipt: TrajectoryReceipt): string =>
  [
    receipt.canonical.taskId,
    receipt.canonical.trialId,
    receipt.canonical.lifecycle,
  ].join("\0");

export const pairPromotionCohorts = (
  baseline: ScoredReceipt[],
  candidate: Array<ScoredReceipt & { canonicalPayloads: [string, string] }>
): PromotionPair[] => {
  const baselineByKey = new Map(
    baseline.map((item) => [pairKey(item.receipt), item])
  );
  const candidateByKey = new Map(
    candidate.map((item) => [pairKey(item.receipt), item])
  );
  if (
    baselineByKey.size !== baseline.length ||
    candidateByKey.size !== candidate.length
  ) {
    throw new Error(
      "Promotion cohorts contain duplicate task/trial/lifecycle pairs"
    );
  }
  const baselineKeys = [...baselineByKey.keys()].sort();
  const candidateKeys = [...candidateByKey.keys()].sort();
  if (canonicalJson(baselineKeys) !== canonicalJson(candidateKeys)) {
    throw new Error("Promotion cohorts do not contain identical pairs");
  }
  return baselineKeys.map((key) => {
    const baselineItem = baselineByKey.get(key);
    const candidateItem = candidateByKey.get(key);
    if (!baselineItem || !candidateItem) {
      throw new Error(`Promotion pair disappeared: ${key}`);
    }
    return {
      taskId: baselineItem.receipt.canonical.taskId,
      trialId: baselineItem.receipt.canonical.trialId,
      lifecycle: baselineItem.receipt.canonical.lifecycle,
      baseline: baselineItem,
      candidate: candidateItem,
    };
  });
};

const safeReduction = (candidate: number, baseline: number): number | null =>
  baseline > 0 ? 1 - candidate / baseline : null;

export const evaluatePromotionGates = (
  pairs: PromotionPair[]
): PromotionGateResult => {
  const failures: string[] = [];
  if (pairs.length === 0) failures.push("paired_cohort_empty");
  const seen = new Set<string>();
  let baselineSuccess = 0;
  let candidateSuccess = 0;
  let baselineCalls = 0;
  let candidateCalls = 0;
  let baselineBytes = 0;
  let candidateBytes = 0;
  let substantiveClaims = 0;
  let linkedSupportedClaims = 0;

  for (const pair of pairs) {
    const identity = `${pair.taskId}\0${pair.trialId}\0${pair.lifecycle}`;
    if (seen.has(identity)) failures.push(`duplicate_pair:${identity}`);
    seen.add(identity);
    const pairReceipts = [pair.baseline.receipt, pair.candidate.receipt];
    if (
      pairReceipts.some(
        (receipt) =>
          receipt.canonical.taskId !== pair.taskId ||
          receipt.canonical.trialId !== pair.trialId ||
          receipt.canonical.lifecycle !== pair.lifecycle
      )
    ) {
      failures.push(`pair_identity_mismatch:${identity}`);
    }
    if (
      !pair.baseline.score.scored ||
      !pair.candidate.score.scored ||
      pairReceipts.some(
        (receipt) => receipt.canonical.failure.class === "harness_error"
      )
    ) {
      failures.push(`unscored_or_harness_failed_pair:${identity}`);
      continue;
    }
    baselineSuccess += pair.baseline.score.success;
    candidateSuccess += pair.candidate.score.success;
    baselineCalls += pair.baseline.receipt.canonical.agentCalls;
    candidateCalls += pair.candidate.receipt.canonical.agentCalls;
    baselineBytes += pair.baseline.receipt.canonical.modelVisibleUtf8Bytes;
    candidateBytes += pair.candidate.receipt.canonical.modelVisibleUtf8Bytes;
    substantiveClaims += pair.candidate.score.substantiveClaims;
    linkedSupportedClaims += pair.candidate.score.linkedSupportedClaims;
    if (pair.candidate.score.success < pair.baseline.score.success) {
      failures.push(`pairwise_accuracy_loss:${identity}`);
    }
    if (
      pair.candidate.canonicalPayloads[0] !==
      pair.candidate.canonicalPayloads[1]
    ) {
      failures.push(`nondeterministic_capsule_payload:${identity}`);
    }
  }

  const scoredPairs =
    pairs.length -
    failures.filter((failure) =>
      failure.startsWith("unscored_or_harness_failed_pair:")
    ).length;
  const baselineSuccessRate =
    scoredPairs > 0 ? baselineSuccess / scoredPairs : null;
  const candidateSuccessRate =
    scoredPairs > 0 ? candidateSuccess / scoredPairs : null;
  const agentCallReduction = safeReduction(candidateCalls, baselineCalls);
  const contextByteReduction = safeReduction(candidateBytes, baselineBytes);
  const claimLinkageRate =
    substantiveClaims > 0 ? linkedSupportedClaims / substantiveClaims : null;

  if (
    baselineSuccessRate === null ||
    candidateSuccessRate === null ||
    candidateSuccessRate < baselineSuccessRate
  ) {
    failures.push("aggregate_accuracy_loss_or_empty_denominator");
  }
  if (agentCallReduction === null || agentCallReduction < 0.25) {
    failures.push("agent_call_reduction_below_0.25_or_zero_denominator");
  }
  if (contextByteReduction === null || contextByteReduction < 0.35) {
    failures.push("context_byte_reduction_below_0.35_or_zero_denominator");
  }
  if (claimLinkageRate === null || claimLinkageRate < 0.95) {
    failures.push("claim_linkage_below_0.95_or_zero_denominator");
  }

  return {
    passed: failures.length === 0,
    pairCount: pairs.length,
    failures,
    metrics: {
      baselineSuccessRate,
      candidateSuccessRate,
      agentCallReduction,
      contextByteReduction,
      claimLinkageRate,
    },
  };
};
