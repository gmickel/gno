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
import { receiptFixture } from "./fixtures";

const successfulScore = (taskId: string): TaskScore => ({
  taskId,
  scored: true,
  exclusionReason: null,
  success: 1,
  completed: true,
  supportedClaims: ["incidentId"],
  unsupportedClaims: [],
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
  const payload = canonicalJson({
    schemaVersion: "eval-capsule-prototype-v1",
    evalOnly: true,
    taskId: receipt.canonical.taskId,
  });
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
  return {
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
    const raw = `{"taskId":"${noncanonical.taskId}","schemaVersion":"eval-capsule-prototype-v1","evalOnly":true}`;
    noncanonical.candidate.replay.first = {
      canonicalJson: raw,
      sha256: sha256Bytes(raw),
    };
    expect(evaluatePromotionGates([noncanonical]).failures).toContainEqual(
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
