import type { ScoredReceipt } from "./scoring";
import type {
  CapsuleReplayRecord,
  PromotionGateResult,
  PromotionPair,
  TrajectoryReceipt,
} from "./types";

import { CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION } from "../../src/app/context-agent-projection";
import { canonicalJson, sha256Bytes } from "./canonical";

const pairKey = (receipt: TrajectoryReceipt): string =>
  [
    receipt.canonical.taskId,
    receipt.canonical.trialId,
    receipt.canonical.lifecycle,
    String(receipt.canonical.seed),
    receipt.canonical.agentId,
  ].join("\0");

export const pairPromotionCohorts = (
  baseline: ScoredReceipt[],
  candidate: Array<ScoredReceipt & { replay: CapsuleReplayRecord }>
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
    if (!(baselineItem && candidateItem)) {
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

const scoreMatchesReceipt = (item: PromotionPair["baseline"]): boolean => {
  const canonical = item.receipt.canonical;
  const score = item.score;
  return (
    score.taskId === canonical.taskId &&
    score.adapterId === canonical.adapterId &&
    score.trialId === canonical.trialId &&
    score.seed === canonical.seed &&
    score.lifecycle === canonical.lifecycle &&
    score.agentId === canonical.agentId &&
    score.score.taskId === canonical.taskId
  );
};

const replayMatchesReceipt = (
  replay: CapsuleReplayRecord,
  receipt: TrajectoryReceipt
): boolean => {
  const canonical = receipt.canonical;
  return (
    replay.taskId === canonical.taskId &&
    replay.adapterId === "capsule" &&
    replay.trialId === canonical.trialId &&
    replay.seed === canonical.seed &&
    replay.lifecycle === canonical.lifecycle &&
    replay.agentId === canonical.agentId
  );
};

const validateReplayPayload = (
  payload: CapsuleReplayRecord["first"],
  _taskId: string
): boolean => {
  if (!payload.canonicalJson) return false;
  try {
    const parsed = JSON.parse(payload.canonicalJson) as Record<string, unknown>;
    const budget = parsed.b;
    const retrieval = parsed.r;
    const evidence = parsed.e;
    const guidance = parsed.g;
    const coverage = parsed.c;
    const omissions = parsed.o;
    const hash = (value: unknown): boolean =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const stringArray = (value: unknown): boolean =>
      Array.isArray(value) && value.every((item) => typeof item === "string");
    const nullableNumber = (value: unknown): boolean =>
      value === null || (typeof value === "number" && Number.isFinite(value));
    const validReasonCounts =
      Array.isArray(omissions) &&
      Array.isArray(omissions[1]) &&
      omissions[1].every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "number" &&
          Number.isInteger(pair[1]) &&
          pair[1] > 0
      );
    const countedTotal = validReasonCounts
      ? (omissions[1] as Array<[string, number]>).reduce(
          (sum, [, count]) => sum + count,
          0
        )
      : Number.NaN;
    return (
      canonicalJson(parsed) === payload.canonicalJson &&
      sha256Bytes(payload.canonicalJson) === payload.sha256 &&
      parsed.v === CONTEXT_AGENT_PROJECTION_SCHEMA_VERSION &&
      hash(parsed.id) &&
      Array.isArray(budget) &&
      budget.length === 6 &&
      budget
        .slice(0, 2)
        .every(
          (value) => typeof value === "number" && Number.isFinite(value)
        ) &&
      budget.slice(2, 4).every(nullableNumber) &&
      typeof budget[4] === "string" &&
      (budget[5] === null || hash(budget[5])) &&
      Array.isArray(retrieval) &&
      retrieval.length === 8 &&
      typeof retrieval[0] === "string" &&
      hash(retrieval[1]) &&
      hash(retrieval[2]) &&
      hash(retrieval[3]) &&
      (retrieval[4] === null || hash(retrieval[4])) &&
      (retrieval[5] === null || hash(retrieval[5])) &&
      stringArray(retrieval[6]) &&
      stringArray(retrieval[7]) &&
      Array.isArray(evidence) &&
      evidence.length > 0 &&
      evidence.every(
        (item) =>
          Array.isArray(item) &&
          item.length === 11 &&
          typeof item[0] === "string" &&
          typeof item[1] === "number" &&
          Number.isInteger(item[1]) &&
          typeof item[2] === "number" &&
          Number.isInteger(item[2]) &&
          hash(item[3]) &&
          hash(item[4]) &&
          hash(item[5]) &&
          typeof item[6] === "string" &&
          (item[7] === null || typeof item[7] === "string") &&
          (item[8] === null || typeof item[8] === "string") &&
          Array.isArray(item[9]) &&
          item[9].every(hash) &&
          [
            "local_only",
            "lan",
            "remote",
            "unclassified",
            "unavailable",
          ].includes(item[10] as string)
      ) &&
      Array.isArray(guidance) &&
      guidance.length === 3 &&
      guidance[0] === "untrusted_data" &&
      guidance[1] === "hard_delimited" &&
      Array.isArray(guidance[2]) &&
      guidance[2].every(
        (item) =>
          Array.isArray(item) &&
          item.length === 4 &&
          hash(item[0]) &&
          ["global", "collection", "prefix"].includes(item[1] as string) &&
          typeof item[2] === "string" &&
          typeof item[3] === "string"
      ) &&
      Array.isArray(coverage) &&
      coverage.length === 2 &&
      stringArray(coverage[0]) &&
      Array.isArray(coverage[1]) &&
      coverage[1].every(
        (gap) =>
          Array.isArray(gap) &&
          gap.length === 2 &&
          gap.every((value) => typeof value === "string")
      ) &&
      Array.isArray(omissions) &&
      omissions.length === 2 &&
      typeof omissions[0] === "number" &&
      Number.isInteger(omissions[0]) &&
      omissions[0] >= 0 &&
      countedTotal === omissions[0] &&
      typeof parsed.t === "boolean" &&
      parsed.trust === "untrusted_data"
    );
  } catch {
    return false;
  }
};

const capsuleEvidenceBundlePayload = (
  receipt: TrajectoryReceipt
): string | null => {
  const evidenceBundles = receipt.canonical.calls.filter(
    (call) =>
      call.deliveredToAgent && call.result.resultRole === "evidence_bundle"
  );
  if (evidenceBundles.length !== 1) return null;
  return evidenceBundles[0]?.result.content || null;
};

const equalComparisonFingerprints = (
  baseline: TrajectoryReceipt,
  candidate: TrajectoryReceipt
): boolean => {
  const baselineCanonical = baseline.canonical;
  const candidateCanonical = candidate.canonical;
  return (
    baselineCanonical.seed === candidateCanonical.seed &&
    baselineCanonical.agentId === candidateCanonical.agentId &&
    ["corpus", "prompt", "tools", "model", "runtime"].every(
      (key) =>
        baselineCanonical.fingerprints[
          key as keyof typeof baselineCanonical.fingerprints
        ] ===
        candidateCanonical.fingerprints[
          key as keyof typeof candidateCanonical.fingerprints
        ]
    )
  );
};

const safeReduction = (candidate: number, baseline: number): number | null =>
  baseline > 0 ? 1 - candidate / baseline : null;

export const evaluatePromotionGates = (
  pairs: PromotionPair[]
): PromotionGateResult => {
  const failures: string[] = [];
  if (pairs.length === 0) failures.push("paired_cohort_empty");
  const seen = new Set<string>();
  let validPairCount = 0;
  let baselineSuccess = 0;
  let candidateSuccess = 0;
  let baselineCalls = 0;
  let candidateCalls = 0;
  let baselineBytes = 0;
  let candidateBytes = 0;
  let substantiveClaims = 0;
  let linkedSupportedClaims = 0;
  let baselineUnsupportedClaims = 0;
  let candidateUnsupportedClaims = 0;

  for (const pair of pairs) {
    const identity = [
      pair.taskId,
      pair.trialId,
      pair.lifecycle,
      String(pair.baseline.receipt.canonical.seed),
      pair.baseline.receipt.canonical.agentId,
    ].join("\0");
    const baseline = pair.baseline.receipt.canonical;
    const candidate = pair.candidate.receipt.canonical;
    let valid = true;
    const fail = (code: string): void => {
      failures.push(`${code}:${identity}`);
      valid = false;
    };
    if (seen.has(identity)) fail("duplicate_pair");
    seen.add(identity);
    if (
      [baseline, candidate].some(
        (receipt) =>
          receipt.taskId !== pair.taskId ||
          receipt.trialId !== pair.trialId ||
          receipt.lifecycle !== pair.lifecycle
      )
    )
      fail("pair_identity_mismatch");
    if (baseline.adapterId !== "gno-mcp" || candidate.adapterId !== "capsule")
      fail("adapter_identity_mismatch");
    if (
      !equalComparisonFingerprints(
        pair.baseline.receipt,
        pair.candidate.receipt
      )
    )
      fail("comparison_fingerprint_mismatch");
    if (!scoreMatchesReceipt(pair.baseline))
      fail("baseline_score_identity_mismatch");
    if (!scoreMatchesReceipt(pair.candidate))
      fail("candidate_score_identity_mismatch");
    if (
      !pair.baseline.score.score.scored ||
      !pair.candidate.score.score.scored ||
      baseline.failure.class === "harness_error" ||
      candidate.failure.class === "harness_error"
    )
      fail("unscored_or_harness_failed_pair");
    const replay = pair.candidate.replay;
    if (!replayMatchesReceipt(replay, pair.candidate.receipt))
      fail("capsule_replay_identity_mismatch");
    const candidatePayload = capsuleEvidenceBundlePayload(
      pair.candidate.receipt
    );
    if (!candidatePayload) {
      fail("candidate_capsule_payload_missing_or_ambiguous");
    } else if (
      replay.first.canonicalJson !== candidatePayload ||
      replay.first.sha256 !== sha256Bytes(candidatePayload)
    ) {
      fail("capsule_replay_first_payload_mismatch");
    }
    if (
      !validateReplayPayload(replay.first, pair.taskId) ||
      !validateReplayPayload(replay.second, pair.taskId)
    ) {
      fail("invalid_capsule_payload_replay");
    } else if (
      replay.first.canonicalJson !== replay.second.canonicalJson ||
      replay.first.sha256 !== replay.second.sha256
    ) {
      fail("nondeterministic_capsule_payload");
    }
    if (!valid) continue;
    validPairCount += 1;
    baselineSuccess += pair.baseline.score.score.success;
    candidateSuccess += pair.candidate.score.score.success;
    baselineCalls += baseline.agentCalls;
    candidateCalls += candidate.agentCalls;
    baselineBytes += baseline.modelVisibleUtf8Bytes;
    candidateBytes += candidate.modelVisibleUtf8Bytes;
    substantiveClaims += pair.candidate.score.score.substantiveClaims;
    linkedSupportedClaims += pair.candidate.score.score.linkedSupportedClaims;
    baselineUnsupportedClaims +=
      pair.baseline.score.score.unsupportedSubstantiveClaims.length;
    candidateUnsupportedClaims +=
      pair.candidate.score.score.unsupportedSubstantiveClaims.length;
    if (pair.candidate.score.score.success < pair.baseline.score.score.success)
      failures.push(`pairwise_accuracy_loss:${identity}`);
  }

  const baselineSuccessRate =
    validPairCount > 0 ? baselineSuccess / validPairCount : null;
  const candidateSuccessRate =
    validPairCount > 0 ? candidateSuccess / validPairCount : null;
  const agentCallReduction = safeReduction(candidateCalls, baselineCalls);
  const contextByteReduction = safeReduction(candidateBytes, baselineBytes);
  const claimLinkageRate =
    substantiveClaims > 0 ? linkedSupportedClaims / substantiveClaims : null;
  const unsupportedClaimsComparable =
    validPairCount > 0 && validPairCount === pairs.length;
  const unsupportedClaimReduction = unsupportedClaimsComparable
    ? safeReduction(candidateUnsupportedClaims, baselineUnsupportedClaims)
    : null;
  if (
    baselineSuccessRate === null ||
    candidateSuccessRate === null ||
    candidateSuccessRate < baselineSuccessRate
  )
    failures.push("aggregate_accuracy_loss_or_empty_denominator");
  if (agentCallReduction === null || agentCallReduction < 0.25)
    failures.push("agent_call_reduction_below_0.25_or_zero_denominator");
  if (contextByteReduction === null || contextByteReduction < 0.35)
    failures.push("context_byte_reduction_below_0.35_or_zero_denominator");
  if (claimLinkageRate === null || claimLinkageRate < 0.95)
    failures.push("claim_linkage_below_0.95_or_zero_denominator");
  if (
    unsupportedClaimReduction === null ||
    candidateUnsupportedClaims >= baselineUnsupportedClaims
  ) {
    failures.push(
      "unsupported_claims_not_strictly_reduced_or_zero_denominator"
    );
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
      baselineUnsupportedClaims: unsupportedClaimsComparable
        ? baselineUnsupportedClaims
        : null,
      candidateUnsupportedClaims: unsupportedClaimsComparable
        ? candidateUnsupportedClaims
        : null,
      unsupportedClaimReduction,
    },
  };
};
