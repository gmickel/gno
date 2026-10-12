import { describe, expect, test } from "bun:test";

import type {
  CapsuleReplayRecord,
  PromotionPair,
  TaskScore,
  TrajectoryReceipt,
} from "../../../evals/agentic/types";

import { canonicalJson, sha256Bytes } from "../../../evals/agentic/canonical";
import {
  evaluatePromotionGates,
  pairPromotionCohorts,
} from "../../../evals/agentic/promotion";
import { scoreRecordFor } from "../../../evals/agentic/scoring";
import { productionCapsuleProjectionFixture, receiptFixture } from "./fixtures";

const successfulScore = (taskId: string): TaskScore => ({
  taskId,
  scored: true,
  exclusionReason: null,
  success: 1,
  completed: true,
  supportedClaims: ["incidentId"],
  unsupportedClaims: [],
  unsupportedSubstantiveClaims: [],
  missingRequiredClaims: [],
  forbiddenEvidenceClaims: [],
  invalidOutputs: [],
  correctAbstention: false,
  prematureStop: false,
  unnecessaryRead: false,
  collectionCorrect: true,
  filtersCorrect: true,
  substantiveClaims: 1,
  linkedSupportedClaims: 1,
});

const replayFor = (receipt: TrajectoryReceipt): CapsuleReplayRecord => {
  const payload = productionCapsuleProjectionFixture(receipt.canonical.taskId);
  const firstCall = receipt.canonical.calls[0];
  if (!firstCall) throw new Error("Promotion fixture requires one call");
  firstCall.result.resultRole = "evidence_bundle";
  firstCall.result.content = payload;
  return {
    taskId: receipt.canonical.taskId,
    adapterId: "capsule",
    trialId: receipt.canonical.trialId,
    seed: receipt.canonical.seed,
    lifecycle: receipt.canonical.lifecycle,
    agentId: receipt.canonical.agentId,
    first: { canonicalJson: payload, sha256: sha256Bytes(payload) },
    second: { canonicalJson: payload, sha256: sha256Bytes(payload) },
  };
};

const promotionPair = (): PromotionPair => {
  const baseline = receiptFixture(undefined, {
    adapterId: "gno-mcp",
    agentCalls: 4,
    modelVisibleUtf8Bytes: 100,
  });
  const candidate = receiptFixture(undefined, {
    adapterId: "capsule",
    agentCalls: 3,
    modelVisibleUtf8Bytes: 65,
  });
  const pair: PromotionPair = {
    taskId: baseline.canonical.taskId,
    trialId: baseline.canonical.trialId,
    lifecycle: baseline.canonical.lifecycle,
    baseline: {
      receipt: baseline,
      score: scoreRecordFor(
        baseline,
        successfulScore(baseline.canonical.taskId)
      ),
    },
    candidate: {
      receipt: candidate,
      score: scoreRecordFor(
        candidate,
        successfulScore(candidate.canonical.taskId)
      ),
      replay: replayFor(candidate),
    },
  };
  pair.baseline.score.score.unsupportedClaims = ["legacy-unsupported"];
  pair.baseline.score.score.unsupportedSubstantiveClaims = [
    "legacy-unsupported",
  ];
  return pair;
};

describe("strict Capsule promotion identity", () => {
  test("fails wrong adapters, seed, agent, or shared fingerprint", () => {
    const adapter = promotionPair();
    adapter.baseline.receipt.canonical.adapterId = "lexical";
    adapter.baseline.score.adapterId = "lexical";
    expect(evaluatePromotionGates([adapter]).failures).toContainEqual(
      expect.stringContaining("adapter_identity_mismatch")
    );

    const seed = promotionPair();
    seed.candidate.receipt.canonical.seed = 99;
    seed.candidate.score.seed = 99;
    seed.candidate.replay.seed = 99;
    expect(evaluatePromotionGates([seed]).failures).toContainEqual(
      expect.stringContaining("comparison_fingerprint_mismatch")
    );

    const agent = promotionPair();
    agent.candidate.receipt.canonical.agentId = "other-agent";
    agent.candidate.score.agentId = "other-agent";
    agent.candidate.replay.agentId = "other-agent";
    expect(evaluatePromotionGates([agent]).failures).toContainEqual(
      expect.stringContaining("comparison_fingerprint_mismatch")
    );

    const fingerprint = promotionPair();
    fingerprint.candidate.receipt.canonical.fingerprints.runtime = "1".repeat(
      64
    );
    expect(evaluatePromotionGates([fingerprint]).failures).toContainEqual(
      expect.stringContaining("comparison_fingerprint_mismatch")
    );
  });

  test("fails score identity and absent, invalid, or noncanonical payloads", () => {
    const score = promotionPair();
    score.candidate.score.trialId = "wrong";
    expect(evaluatePromotionGates([score]).failures).toContainEqual(
      expect.stringContaining("candidate_score_identity_mismatch")
    );

    const absent = promotionPair();
    absent.candidate.replay.first.canonicalJson = "";
    absent.candidate.replay.first.sha256 = sha256Bytes("");
    expect(evaluatePromotionGates([absent]).failures).toContainEqual(
      expect.stringContaining("invalid_capsule_payload_replay")
    );

    const noncanonical = promotionPair();
    const raw = JSON.stringify(
      JSON.parse(productionCapsuleProjectionFixture(noncanonical.taskId)),
      null,
      2
    );
    noncanonical.candidate.replay.first = {
      canonicalJson: raw,
      sha256: sha256Bytes(raw),
    };
    expect(evaluatePromotionGates([noncanonical]).failures).toContainEqual(
      expect.stringContaining("invalid_capsule_payload_replay")
    );

    const sentinel = promotionPair();
    const sentinelPayload = productionCapsuleProjectionFixture(
      `${sentinel.taskId}-sentinel`
    );
    sentinel.candidate.replay.first = {
      canonicalJson: sentinelPayload,
      sha256: sha256Bytes(sentinelPayload),
    };
    sentinel.candidate.replay.second = structuredClone(
      sentinel.candidate.replay.first
    );
    expect(evaluatePromotionGates([sentinel]).failures).toContainEqual(
      expect.stringContaining("capsule_replay_first_payload_mismatch")
    );

    const ambiguous = promotionPair();
    ambiguous.candidate.receipt.canonical.calls.push(
      structuredClone(ambiguous.candidate.receipt.canonical.calls[0]!)
    );
    expect(evaluatePromotionGates([ambiguous]).failures).toContainEqual(
      expect.stringContaining("candidate_capsule_payload_missing_or_ambiguous")
    );
  });

  test("accepts v2 payloads and recorded v1 receipts, but not mixed shapes", () => {
    const withPayload = (
      edit: (projection: { v: string; e: unknown[][] }) => void
    ): PromotionPair => {
      const pair = promotionPair();
      const projection = JSON.parse(
        productionCapsuleProjectionFixture(pair.taskId)
      ) as { v: string; e: unknown[][] };
      edit(projection);
      const payload = canonicalJson(projection);
      pair.candidate.receipt.canonical.calls[0]!.result.content = payload;
      pair.candidate.replay.first = {
        canonicalJson: payload,
        sha256: sha256Bytes(payload),
      };
      pair.candidate.replay.second = structuredClone(
        pair.candidate.replay.first
      );
      return pair;
    };
    const replayFailures = (pair: PromotionPair): string[] =>
      evaluatePromotionGates([pair]).failures.filter((failure) =>
        failure.includes("capsule")
      );

    const v2 = withPayload((projection) => {
      expect(projection.v).toBe("gno-context-agent-v2");
      expect(projection.e[0]).toHaveLength(13);
    });
    expect(replayFailures(v2)).toEqual([]);

    const v1 = withPayload((projection) => {
      projection.v = "gno-context-agent-v1";
      projection.e = projection.e.map((item) => item.slice(0, 11));
    });
    expect(replayFailures(v1)).toEqual([]);

    const v1WithV2Tuples = withPayload((projection) => {
      projection.v = "gno-context-agent-v1";
    });
    expect(replayFailures(v1WithV2Tuples)).toContainEqual(
      expect.stringContaining("invalid_capsule_payload_replay")
    );

    const badDate = withPayload((projection) => {
      projection.e[0]![11] = 20_261_012;
    });
    expect(replayFailures(badDate)).toContainEqual(
      expect.stringContaining("invalid_capsule_payload_replay")
    );
  });

  test("pairing rejects duplicate, missing, seed, and agent identities", () => {
    const pair = promotionPair();
    const baseline = [pair.baseline];
    const candidate = [pair.candidate];
    expect(pairPromotionCohorts(baseline, candidate)).toHaveLength(1);
    expect(() =>
      pairPromotionCohorts([...baseline, ...baseline], candidate)
    ).toThrow("duplicate");
    expect(() => pairPromotionCohorts(baseline, [])).toThrow("identical pairs");
    const seedChanged = structuredClone(candidate);
    seedChanged[0]!.receipt.canonical.seed = 2;
    expect(() => pairPromotionCohorts(baseline, seedChanged)).toThrow(
      "identical pairs"
    );
    const agentChanged = structuredClone(candidate);
    agentChanged[0]!.receipt.canonical.agentId = "different";
    expect(() => pairPromotionCohorts(baseline, agentChanged)).toThrow(
      "identical pairs"
    );
  });
});
