import type { ClaimValue, NormalizerId } from "./types";

import { canonicalFingerprint, canonicalJson } from "./canonical";

export const VERIFIED_ASK_BENCHMARK_ID = "verified-ask-outcome@1" as const;
export const VERIFIED_ASK_AGENT_ID = "fixture-answer-agent-v1" as const;
export const VERIFIED_ASK_TRIAL_ID = "verified-ask-fixture-01" as const;
export const VERIFIED_ASK_SEED = 0 as const;
export const VERIFIED_ASK_LANES = ["raw_ask", "verified_ask"] as const;
export type VerifiedAskLane = (typeof VERIFIED_ASK_LANES)[number];

export interface VerifiedAskOutcomeCitation {
  evidenceId: string | null;
  uri: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
  mirrorHash: string;
  passageHash: string;
}

export interface VerifiedAskOutcomeReceipt {
  taskId: string;
  lane: VerifiedAskLane;
  trialId: typeof VERIFIED_ASK_TRIAL_ID;
  seed: typeof VERIFIED_ASK_SEED;
  agentId: typeof VERIFIED_ASK_AGENT_ID;
  fixtureFingerprint: string;
  indexFingerprint: string;
  requestFingerprint: string;
  modelFingerprint: string;
  draftKind: "supported" | "adversarial";
  declaredClaim: { claimKey: string; value: ClaimValue } | null;
  answer: string;
  answerFingerprint: string;
  abstained: boolean;
  citations: VerifiedAskOutcomeCitation[];
  verification: {
    requested: boolean;
    answerStatus: "raw" | "verified" | "abstained";
  };
  canonicalFingerprint: string;
}

export interface VerifiedAskOutcomeScore {
  taskId: string;
  lane: VerifiedAskLane;
  trialId: typeof VERIFIED_ASK_TRIAL_ID;
  seed: typeof VERIFIED_ASK_SEED;
  agentId: typeof VERIFIED_ASK_AGENT_ID;
  answerAccuracy: 0 | 1;
  unsupportedSubstantiveClaims: string[];
}

export interface VerifiedAskPromotionArtifact {
  schemaVersion: "1.0";
  benchmarkId: typeof VERIFIED_ASK_BENCHMARK_ID;
  canonicalFingerprint: string;
  fixtureFingerprint: string;
  indexFingerprint: string;
  methodology: string[];
  excludedTasks: Array<{ taskId: string; reason: string }>;
  receipts: VerifiedAskOutcomeReceipt[];
  scores: VerifiedAskOutcomeScore[];
  promotion: {
    passed: boolean;
    pairCount: number;
    failures: string[];
    metrics: {
      baselineAnswerAccuracy: number | null;
      candidateAnswerAccuracy: number | null;
      baselineUnsupportedSubstantiveClaims: number | null;
      candidateUnsupportedSubstantiveClaims: number | null;
      unsupportedSubstantiveClaimReduction: number | null;
    };
  };
}

const normalizeScalar = (
  value: string | number | boolean,
  normalizer: NormalizerId
): string | number | boolean => {
  if (typeof value !== "string") return value;
  if (normalizer === "trim-lower-v1") return value.trim().toLowerCase();
  if (normalizer === "identifier-v1")
    return value.trim().toUpperCase().replace(/\s+/g, "");
  if (normalizer === "iso-date-v1") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp)
      ? value
      : new Date(timestamp).toISOString().slice(0, 10);
  }
  return value;
};

const normalizedValue = (
  value: ClaimValue,
  normalizer: NormalizerId
): unknown => {
  if (value.type !== "string[]")
    return normalizeScalar(value.value, normalizer);
  const values = value.value.map((item) =>
    String(normalizeScalar(item, normalizer))
  );
  return normalizer === "string-set-v1" ? [...values].sort() : values;
};

export const verifiedAskClaimValuesMatch = (
  actual: ClaimValue,
  expected: ClaimValue,
  normalizer: NormalizerId
): boolean =>
  actual.type === expected.type &&
  canonicalJson(normalizedValue(actual, normalizer)) ===
    canonicalJson(normalizedValue(expected, normalizer));

const pairKey = (
  value: Pick<
    VerifiedAskOutcomeReceipt | VerifiedAskOutcomeScore,
    "taskId" | "trialId" | "seed" | "agentId"
  >
): string =>
  [value.taskId, value.trialId, String(value.seed), value.agentId].join("\0");

export const evaluateVerifiedAskPromotion = (
  receipts: readonly VerifiedAskOutcomeReceipt[],
  scores: readonly VerifiedAskOutcomeScore[]
): VerifiedAskPromotionArtifact["promotion"] => {
  const failures: string[] = [];
  const receiptIdentity = new Set<string>();
  const scoreIdentity = new Set<string>();
  const receiptsByLane = new Map<
    VerifiedAskLane,
    Map<string, VerifiedAskOutcomeReceipt>
  >(VERIFIED_ASK_LANES.map((lane) => [lane, new Map()]));
  const scoresByLane = new Map<
    VerifiedAskLane,
    Map<string, VerifiedAskOutcomeScore>
  >(VERIFIED_ASK_LANES.map((lane) => [lane, new Map()]));
  for (const receipt of receipts) {
    const identity = `${receipt.lane}\0${pairKey(receipt)}`;
    if (receiptIdentity.has(identity))
      failures.push(`duplicate_receipt:${identity}`);
    receiptIdentity.add(identity);
    receiptsByLane.get(receipt.lane)?.set(pairKey(receipt), receipt);
  }
  for (const score of scores) {
    const identity = `${score.lane}\0${pairKey(score)}`;
    if (scoreIdentity.has(identity))
      failures.push(`duplicate_score:${identity}`);
    scoreIdentity.add(identity);
    scoresByLane.get(score.lane)?.set(pairKey(score), score);
  }
  const baseline = receiptsByLane.get("raw_ask")!;
  const candidate = receiptsByLane.get("verified_ask")!;
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  for (const key of keys) {
    const raw = baseline.get(key);
    const verified = candidate.get(key);
    const rawScore = scoresByLane.get("raw_ask")?.get(key);
    const verifiedScore = scoresByLane.get("verified_ask")?.get(key);
    if (!(raw && verified && rawScore && verifiedScore)) {
      failures.push(`missing_or_mismatched_pair:${key}`);
      continue;
    }
    if (
      raw.fixtureFingerprint !== verified.fixtureFingerprint ||
      raw.indexFingerprint !== verified.indexFingerprint ||
      raw.requestFingerprint !== verified.requestFingerprint ||
      raw.modelFingerprint !== verified.modelFingerprint
    )
      failures.push(`pair_fingerprint_mismatch:${key}`);
    if (verifiedScore.answerAccuracy < rawScore.answerAccuracy)
      failures.push(`pairwise_accuracy_regression:${key}`);
  }
  if (
    baseline.size !== candidate.size ||
    keys.length !== baseline.size ||
    receipts.length !== keys.length * 2 ||
    scores.length !== keys.length * 2
  )
    failures.push("cohort_cardinality_mismatch");
  const baselineScores = [...(scoresByLane.get("raw_ask")?.values() ?? [])];
  const candidateScores = [
    ...(scoresByLane.get("verified_ask")?.values() ?? []),
  ];
  const baselineAccuracy =
    baselineScores.length === 0
      ? null
      : baselineScores.reduce((sum, score) => sum + score.answerAccuracy, 0) /
        baselineScores.length;
  const candidateAccuracy =
    candidateScores.length === 0
      ? null
      : candidateScores.reduce((sum, score) => sum + score.answerAccuracy, 0) /
        candidateScores.length;
  const baselineUnsupported = baselineScores.reduce(
    (sum, score) => sum + score.unsupportedSubstantiveClaims.length,
    0
  );
  const candidateUnsupported = candidateScores.reduce(
    (sum, score) => sum + score.unsupportedSubstantiveClaims.length,
    0
  );
  if (
    baselineAccuracy === null ||
    candidateAccuracy === null ||
    candidateAccuracy < baselineAccuracy
  )
    failures.push("aggregate_accuracy_regression");
  if (baselineUnsupported === 0 || candidateUnsupported >= baselineUnsupported)
    failures.push("unsupported_claims_not_strictly_reduced");
  const comparable = failures.every(
    (failure) =>
      failure !== "cohort_cardinality_mismatch" &&
      !failure.startsWith("duplicate_") &&
      !failure.startsWith("missing_or_mismatched_pair") &&
      !failure.startsWith("pair_fingerprint_mismatch")
  );
  return {
    passed: failures.length === 0,
    pairCount: comparable ? keys.length : 0,
    failures,
    metrics: {
      baselineAnswerAccuracy: comparable ? baselineAccuracy : null,
      candidateAnswerAccuracy: comparable ? candidateAccuracy : null,
      baselineUnsupportedSubstantiveClaims: comparable
        ? baselineUnsupported
        : null,
      candidateUnsupportedSubstantiveClaims: comparable
        ? candidateUnsupported
        : null,
      unsupportedSubstantiveClaimReduction:
        comparable && baselineUnsupported > 0
          ? (baselineUnsupported - candidateUnsupported) / baselineUnsupported
          : null,
    },
  };
};

export const verifiedAskArtifactFingerprint = (
  artifact: Omit<VerifiedAskPromotionArtifact, "canonicalFingerprint">
): string => canonicalFingerprint(artifact);

export const renderVerifiedAskPromotionMarkdown = (
  artifact: VerifiedAskPromotionArtifact
): string => {
  const metrics = artifact.promotion.metrics;
  return `# Verified Ask promotion

Canonical fingerprint: \`${artifact.canonicalFingerprint}\`

Verdict: **${artifact.promotion.passed ? "PASS" : "FAIL"}**

- Cohort: ${artifact.promotion.pairCount} paired tasks
- Baseline: production raw Ask
- Candidate: production \`buildVerifiedAsk\`
- Answer accuracy (raw/verified): ${metrics.baselineAnswerAccuracy} / ${metrics.candidateAnswerAccuracy}
- Unsupported substantive claims (raw/verified): ${metrics.baselineUnsupportedSubstantiveClaims} / ${metrics.candidateUnsupportedSubstantiveClaims}
- Unsupported-claim reduction: ${metrics.unsupportedSubstantiveClaimReduction}
- Excluded: ${artifact.excludedTasks.map((item) => `${item.taskId} (${item.reason})`).join(", ")}
- Failures: ${artifact.promotion.failures.length > 0 ? artifact.promotion.failures.join(", ") : "none"}

## Methodology

${artifact.methodology.map((item) => `- ${item}`).join("\n")}
`;
};
