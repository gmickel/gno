import type { ClaimValue, HiddenOracle, NormalizerId } from "./types";

import { CLAIM_ABSTENTION_TEXT } from "../../src/pipeline/claim-verification";
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
  environment: { git: { commit: string; dirty: boolean } };
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

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

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

export const encodeVerifiedAskClaim = (
  claimKey: string,
  value: ClaimValue
): string =>
  `claim ${claimKey} value ${encodeURIComponent(canonicalJson(value))}`;

const validClaimValue = (
  value: unknown,
  expectedType: ClaimValue["type"]
): value is ClaimValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "type,value" ||
    record.type !== expectedType
  )
    return false;
  if (expectedType === "number") return typeof record.value === "number";
  if (expectedType === "boolean") return typeof record.value === "boolean";
  if (expectedType === "string[]")
    return (
      Array.isArray(record.value) &&
      record.value.every((item) => typeof item === "string")
    );
  return typeof record.value === "string";
};

const claimFromAnswer = (
  receipt: VerifiedAskOutcomeReceipt,
  oracle: HiddenOracle
): ClaimValue | null => {
  if (receipt.abstained) return null;
  const expected = oracle.claims[0];
  if (!expected) return null;
  const prefix = `claim ${expected.claimKey} value `;
  if (
    receipt.answer.indexOf(prefix) < 0 ||
    receipt.answer.indexOf(prefix) !== receipt.answer.lastIndexOf(prefix)
  )
    return null;
  const encoded = receipt.answer
    .slice(receipt.answer.indexOf(prefix) + prefix.length)
    .split(/\s/u)[0];
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    return validClaimValue(parsed, expected.expectedValue.type) ? parsed : null;
  } catch {
    return null;
  }
};

const identityKey = (
  value: Pick<
    VerifiedAskOutcomeReceipt | VerifiedAskOutcomeScore,
    "taskId" | "trialId" | "seed" | "agentId"
  >
): string =>
  [value.taskId, value.trialId, String(value.seed), value.agentId].join("\0");

export const scoreVerifiedAskReceipt = (
  receipt: VerifiedAskOutcomeReceipt,
  oracle: HiddenOracle
): VerifiedAskOutcomeScore => {
  const expected = oracle.claims[0];
  const actual = claimFromAnswer(receipt, oracle);
  if (!expected) throw new Error(`Oracle claim missing for ${receipt.taskId}`);
  const accurate =
    actual !== null &&
    verifiedAskClaimValuesMatch(
      actual,
      expected.expectedValue,
      expected.normalizer.id
    );
  return {
    taskId: receipt.taskId,
    lane: receipt.lane,
    trialId: receipt.trialId,
    seed: receipt.seed,
    agentId: receipt.agentId,
    answerAccuracy: accurate ? 1 : 0,
    unsupportedSubstantiveClaims:
      actual && !accurate ? [expected.claimKey] : [],
  };
};

const receiptWithoutFingerprint = (
  receipt: VerifiedAskOutcomeReceipt
): Omit<VerifiedAskOutcomeReceipt, "canonicalFingerprint"> => {
  const { canonicalFingerprint: _fingerprint, ...canonical } = receipt;
  return canonical;
};

const citationIssues = (receipt: VerifiedAskOutcomeReceipt): string[] => {
  const issues: string[] = [];
  for (const citation of receipt.citations) {
    if (
      !citation.uri.startsWith("gno://") ||
      citation.startLine < 1 ||
      citation.endLine < citation.startLine ||
      !SHA256.test(citation.sourceHash) ||
      !SHA256.test(citation.mirrorHash) ||
      !SHA256.test(citation.passageHash)
    )
      issues.push("citation_contract_invalid");
  }
  return issues;
};

const receiptIssues = (
  receipt: VerifiedAskOutcomeReceipt,
  oracle: HiddenOracle
): string[] => {
  const issues = citationIssues(receipt);
  if (
    !SHA256.test(receipt.fixtureFingerprint) ||
    !SHA256.test(receipt.indexFingerprint) ||
    !SHA256.test(receipt.requestFingerprint) ||
    !SHA256.test(receipt.modelFingerprint)
  )
    issues.push("input_fingerprint_invalid");
  if (
    canonicalFingerprint(receiptWithoutFingerprint(receipt)) !==
    receipt.canonicalFingerprint
  )
    issues.push("receipt_fingerprint_mismatch");
  if (canonicalFingerprint(receipt.answer) !== receipt.answerFingerprint)
    issues.push("answer_fingerprint_mismatch");
  const claim = claimFromAnswer(receipt, oracle);
  if (!receipt.abstained && !claim) issues.push("answer_claim_unparseable");
  if (receipt.lane === "raw_ask") {
    if (
      receipt.verification.requested ||
      receipt.verification.answerStatus !== "raw" ||
      receipt.abstained ||
      receipt.citations.length === 0 ||
      receipt.citations.some((citation) => citation.evidenceId !== null) ||
      !receipt.answer.includes("[1]") ||
      receipt.answer.includes("[evidence:")
    )
      issues.push("raw_lane_semantics_invalid");
  } else if (
    !receipt.verification.requested ||
    !["verified", "abstained"].includes(receipt.verification.answerStatus)
  ) {
    issues.push("verified_lane_semantics_invalid");
  } else if (receipt.verification.answerStatus === "abstained") {
    if (
      !receipt.abstained ||
      receipt.answer !== CLAIM_ABSTENTION_TEXT ||
      receipt.citations.length !== 0 ||
      claim !== null
    )
      issues.push("verified_abstention_invalid");
  } else if (
    receipt.abstained ||
    receipt.citations.length === 0 ||
    receipt.citations.some(
      (citation) =>
        !citation.evidenceId ||
        !SHA256.test(citation.evidenceId) ||
        !receipt.answer.includes(`[evidence:${citation.evidenceId}]`)
    ) ||
    receipt.answer.includes("[1]")
  ) {
    issues.push("verified_answer_invalid");
  }
  return [...new Set(issues)];
};

const unavailableMetrics =
  (): VerifiedAskPromotionArtifact["promotion"]["metrics"] => ({
    baselineAnswerAccuracy: null,
    candidateAnswerAccuracy: null,
    baselineUnsupportedSubstantiveClaims: null,
    candidateUnsupportedSubstantiveClaims: null,
    unsupportedSubstantiveClaimReduction: null,
  });

export const evaluateVerifiedAskPromotion = (
  receipts: readonly VerifiedAskOutcomeReceipt[],
  scores: readonly VerifiedAskOutcomeScore[],
  oracles: ReadonlyMap<string, HiddenOracle>
): VerifiedAskPromotionArtifact["promotion"] => {
  const failures: string[] = [];
  const receiptMaps = new Map(
    VERIFIED_ASK_LANES.map((lane) => [
      lane,
      new Map<string, VerifiedAskOutcomeReceipt>(),
    ])
  );
  const scoreMaps = new Map(
    VERIFIED_ASK_LANES.map((lane) => [
      lane,
      new Map<string, VerifiedAskOutcomeScore>(),
    ])
  );
  for (const receipt of receipts) {
    const key = identityKey(receipt);
    const lane = receiptMaps.get(receipt.lane);
    if (!lane || lane.has(key)) failures.push(`duplicate_receipt:${key}`);
    lane?.set(key, receipt);
  }
  for (const score of scores) {
    const key = identityKey(score);
    const lane = scoreMaps.get(score.lane);
    if (!lane || lane.has(key)) failures.push(`duplicate_score:${key}`);
    lane?.set(key, score);
  }
  const baseline = receiptMaps.get("raw_ask")!;
  const candidate = receiptMaps.get("verified_ask")!;
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const recomputed = new Map<VerifiedAskLane, VerifiedAskOutcomeScore[]>(
    VERIFIED_ASK_LANES.map((lane) => [lane, []])
  );
  for (const key of keys) {
    const raw = baseline.get(key);
    const verified = candidate.get(key);
    const oracle = oracles.get(raw?.taskId ?? verified?.taskId ?? "");
    const rawScore = scoreMaps.get("raw_ask")?.get(key);
    const verifiedScore = scoreMaps.get("verified_ask")?.get(key);
    if (!(raw && verified && oracle && rawScore && verifiedScore)) {
      failures.push(`missing_or_mismatched_pair:${key}`);
      continue;
    }
    for (const receipt of [raw, verified]) {
      for (const issue of receiptIssues(receipt, oracle))
        failures.push(`${issue}:${receipt.lane}:${key}`);
    }
    if (
      raw.fixtureFingerprint !== verified.fixtureFingerprint ||
      raw.indexFingerprint !== verified.indexFingerprint ||
      raw.requestFingerprint !== verified.requestFingerprint ||
      raw.modelFingerprint !== verified.modelFingerprint ||
      raw.draftKind !== verified.draftKind
    )
      failures.push(`pair_fingerprint_mismatch:${key}`);
    const derivedRaw = scoreVerifiedAskReceipt(raw, oracle);
    const derivedVerified = scoreVerifiedAskReceipt(verified, oracle);
    recomputed.get("raw_ask")!.push(derivedRaw);
    recomputed.get("verified_ask")!.push(derivedVerified);
    if (canonicalJson(rawScore) !== canonicalJson(derivedRaw))
      failures.push(`score_receipt_mismatch:raw_ask:${key}`);
    if (canonicalJson(verifiedScore) !== canonicalJson(derivedVerified))
      failures.push(`score_receipt_mismatch:verified_ask:${key}`);
    const rawExpectedKind =
      derivedRaw.answerAccuracy === 1 ? "supported" : "adversarial";
    if (
      raw.draftKind !== rawExpectedKind ||
      verified.draftKind !== rawExpectedKind
    )
      failures.push(`draft_kind_mismatch:${key}`);
    if (derivedVerified.answerAccuracy < derivedRaw.answerAccuracy)
      failures.push(`pairwise_accuracy_regression:${key}`);
  }
  if (
    baseline.size !== candidate.size ||
    keys.length !== baseline.size ||
    receipts.length !== keys.length * 2 ||
    scores.length !== keys.length * 2
  )
    failures.push("cohort_cardinality_mismatch");
  const integrityFailure = failures.some(
    (failure) =>
      !failure.startsWith("pairwise_accuracy_regression") &&
      failure !== "aggregate_accuracy_regression" &&
      failure !== "unsupported_claims_not_strictly_reduced"
  );
  if (integrityFailure)
    return {
      passed: false,
      pairCount: 0,
      failures,
      metrics: unavailableMetrics(),
    };
  const rawScores = recomputed.get("raw_ask")!;
  const verifiedScores = recomputed.get("verified_ask")!;
  const baselineAccuracy =
    rawScores.reduce((sum, score) => sum + score.answerAccuracy, 0) /
    rawScores.length;
  const candidateAccuracy =
    verifiedScores.reduce((sum, score) => sum + score.answerAccuracy, 0) /
    verifiedScores.length;
  const baselineUnsupported = rawScores.reduce(
    (sum, score) => sum + score.unsupportedSubstantiveClaims.length,
    0
  );
  const candidateUnsupported = verifiedScores.reduce(
    (sum, score) => sum + score.unsupportedSubstantiveClaims.length,
    0
  );
  if (candidateAccuracy < baselineAccuracy)
    failures.push("aggregate_accuracy_regression");
  if (baselineUnsupported === 0 || candidateUnsupported >= baselineUnsupported)
    failures.push("unsupported_claims_not_strictly_reduced");
  return {
    passed: failures.length === 0,
    pairCount: keys.length,
    failures,
    metrics: {
      baselineAnswerAccuracy: baselineAccuracy,
      candidateAnswerAccuracy: candidateAccuracy,
      baselineUnsupportedSubstantiveClaims: baselineUnsupported,
      candidateUnsupportedSubstantiveClaims: candidateUnsupported,
      unsupportedSubstantiveClaimReduction:
        baselineUnsupported > 0
          ? (baselineUnsupported - candidateUnsupported) / baselineUnsupported
          : null,
    },
  };
};

export const verifiedAskArtifactFingerprint = (
  artifact: Omit<VerifiedAskPromotionArtifact, "canonicalFingerprint">
): string => canonicalFingerprint(artifact);

export const validateVerifiedAskPromotionArtifact = (
  artifact: VerifiedAskPromotionArtifact,
  oracles: ReadonlyMap<string, HiddenOracle>
): string[] => {
  const failures: string[] = [];
  const { canonicalFingerprint: _fingerprint, ...projection } = artifact;
  if (
    verifiedAskArtifactFingerprint(projection) !== artifact.canonicalFingerprint
  )
    failures.push("artifact_fingerprint_mismatch");
  if (
    !GIT_SHA.test(artifact.environment.git.commit) ||
    artifact.environment.git.dirty
  )
    failures.push("artifact_git_provenance_invalid");
  if (
    artifact.benchmarkId !== VERIFIED_ASK_BENCHMARK_ID ||
    artifact.schemaVersion !== "1.0" ||
    artifact.receipts.some(
      (receipt) =>
        receipt.fixtureFingerprint !== artifact.fixtureFingerprint ||
        receipt.indexFingerprint !== artifact.indexFingerprint
    )
  )
    failures.push("artifact_identity_mismatch");
  const promotion = evaluateVerifiedAskPromotion(
    artifact.receipts,
    artifact.scores,
    oracles
  );
  if (canonicalJson(promotion) !== canonicalJson(artifact.promotion))
    failures.push("artifact_promotion_mismatch");
  return failures;
};

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
