import type { ScoredReceipt } from "./scoring";
import type {
  CapsuleReplayRecord,
  PromotionGateResult,
  PromotionPair,
  TrajectoryReceipt,
} from "./types";

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
  taskId: string
): boolean => {
  if (!payload.canonicalJson) return false;
  try {
    const parsed = JSON.parse(payload.canonicalJson) as Record<string, unknown>;
    return (
      canonicalJson(parsed) === payload.canonicalJson &&
      sha256Bytes(payload.canonicalJson) === payload.sha256 &&
      parsed.schemaVersion === "eval-capsule-prototype-v1" &&
      parsed.evalOnly === true &&
      parsed.taskId === taskId
    );
  } catch {
    return false;
  }
};

const capsuleEvidenceBundlePayload = (
  receipt: TrajectoryReceipt
): string | null => {
  const evidenceBundles = receipt.canonical.calls.filter(
    (call) => call.result.resultRole === "evidence_bundle"
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
