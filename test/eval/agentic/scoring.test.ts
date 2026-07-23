import { describe, expect, test } from "bun:test";

import type {
  FinalEnvelope,
  PromotionPair,
  TrajectoryReceipt,
} from "../../../evals/agentic/types";

import {
  modelVisibleUtf8Bytes,
  sha256Bytes,
} from "../../../evals/agentic/canonical";
import {
  evaluatePromotionGates,
  pairPromotionCohorts,
} from "../../../evals/agentic/promotion";
import {
  scoreTrajectory,
  scoreRecordFor,
  type ScoredReceipt,
} from "../../../evals/agentic/scoring";
import {
  evidence,
  finalEnvelopeFixture,
  oracleFixture,
  productionCapsuleProjectionFixture,
  receiptFixture,
  taskFixture,
} from "./fixtures";

describe("deterministic trajectory scoring", () => {
  test("scores a supported completed claim with exact evidence", () => {
    const coordinate = evidence();
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(coordinate),
      receiptFixture(coordinate)
    );
    expect(score).toMatchObject({
      scored: true,
      success: 1,
      completed: true,
      supportedClaims: ["incidentId"],
      unsupportedClaims: [],
      missingRequiredClaims: [],
      forbiddenEvidenceClaims: [],
      prematureStop: false,
      unnecessaryRead: false,
      collectionCorrect: true,
      filtersCorrect: true,
    });
  });

  test("distinguishes unsupported values and premature completion", () => {
    const coordinate = evidence();
    const envelope = finalEnvelopeFixture(coordinate);
    envelope.claims[0] = {
      claimKey: "incidentId",
      value: { type: "identifier", value: "INC-9999" },
      citations: [coordinate],
    };
    const receipt = receiptFixture(coordinate, { finalEnvelope: envelope });
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(coordinate),
      receipt
    );
    expect(score.success).toBe(0);
    expect(score.unsupportedClaims).toEqual(["incidentId"]);
    expect(score.prematureStop).toBe(true);
  });

  test("distinguishes missing required evidence", () => {
    const coordinate = evidence();
    const envelope = finalEnvelopeFixture(coordinate);
    envelope.claims = [];
    envelope.gaps = [];
    const receipt = receiptFixture(coordinate, { finalEnvelope: envelope });
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(coordinate),
      receipt
    );
    expect(score.success).toBe(0);
    expect(score.missingRequiredClaims).toEqual(["incidentId"]);
    expect(score.invalidOutputs).toContain("missing_required_claim:incidentId");
    expect(score.prematureStop).toBe(true);
  });

  test("distinguishes forbidden evidence", () => {
    const required = evidence();
    const forbidden = evidence({
      uri: "gno://c001/d002.md",
      sourceHash: "1".repeat(64),
      spanHash: "2".repeat(64),
    });
    const oracle = oracleFixture(required);
    const oracleClaim = oracle.claims[0];
    if (!oracleClaim) throw new Error("oracle claim missing");
    oracleClaim.forbiddenEvidence = [forbidden];
    const envelope = finalEnvelopeFixture(required);
    const actualClaim = envelope.claims[0];
    if (!actualClaim) throw new Error("actual claim missing");
    actualClaim.citations.push(forbidden);
    const score = scoreTrajectory(
      taskFixture(),
      oracle,
      receiptFixture(required, { finalEnvelope: envelope })
    );
    expect(score.success).toBe(0);
    expect(score.forbiddenEvidenceClaims).toEqual(["incidentId"]);
  });

  test("rejects citations the agent never observed", () => {
    const coordinate = evidence();
    const receipt = receiptFixture(coordinate);
    const call = receipt.canonical.calls[0];
    if (!call) throw new Error("call missing");
    call.result.evidence = [];
    call.modelVisibleUtf8Bytes = modelVisibleUtf8Bytes(call.result);
    receipt.canonical.modelVisibleUtf8Bytes = call.modelVisibleUtf8Bytes;
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(coordinate),
      receipt
    );
    expect(score.success).toBe(0);
    expect(score.unsupportedClaims).toEqual(["incidentId"]);
  });

  test("does not accept backend-provided hashes as harness-observed evidence", () => {
    const required = evidence();
    const spoofed = evidence({
      sourceHashProvenance: "backend_provided",
      spanHashProvenance: "backend_provided",
    });
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(required),
      receiptFixture(spoofed)
    );
    expect(score.success).toBe(0);
    expect(score.unsupportedClaims).toEqual(["incidentId"]);
  });

  test("scores expected missing evidence as correct abstention", () => {
    const task = taskFixture();
    const oracle = oracleFixture(evidence(), {
      claims: [],
      expectedMissing: ["incidentId"],
      completion: {
        expectAbstention: true,
        maxAgentCalls: 3,
        maxModelVisibleBytes: 1000,
        failOnUnexpectedEvidence: false,
      },
    });
    const envelope: FinalEnvelope = {
      schemaVersion: "1.0",
      claims: [],
      gaps: [{ claimKey: "incidentId", reason: "missing_evidence" }],
      abstained: true,
      stopReason: "abstained",
    };
    const receipt = receiptFixture(evidence(), {
      finalEnvelope: envelope,
      stopReason: "abstained",
    });
    const score = scoreTrajectory(task, oracle, receipt);
    expect(score.success).toBe(1);
    expect(score.completed).toBe(true);
    expect(score.correctAbstention).toBe(true);
  });

  test("rejects duplicate or unknown gaps during otherwise correct abstention", () => {
    const task = taskFixture();
    const oracle = oracleFixture(evidence(), {
      claims: [],
      expectedMissing: ["incidentId"],
      completion: {
        expectAbstention: true,
        maxAgentCalls: 3,
        maxModelVisibleBytes: 1000,
        failOnUnexpectedEvidence: false,
      },
    });
    const envelope: FinalEnvelope = {
      schemaVersion: "1.0",
      claims: [],
      gaps: [
        { claimKey: "incidentId", reason: "missing_evidence" },
        { claimKey: "incidentId", reason: "missing_evidence" },
      ],
      abstained: true,
      stopReason: "abstained",
    };
    const receipt = receiptFixture(evidence(), {
      finalEnvelope: envelope,
      stopReason: "abstained",
    });
    const score = scoreTrajectory(task, oracle, receipt);
    expect(score.correctAbstention).toBe(false);
    expect(score.completed).toBe(false);
    expect(score.success).toBe(0);
    expect(score.invalidOutputs).toContain("duplicate_gap:incidentId");
  });

  test("rejects arbitrary prose and unknown final claims", () => {
    const receipt = receiptFixture();
    const proseOutput = {
      ...finalEnvelopeFixture(),
      answer: "The incident was INC-4827.",
    };
    const proseScore = scoreTrajectory(
      taskFixture(),
      oracleFixture(),
      receipt,
      proseOutput
    );
    expect(proseScore.success).toBe(0);
    expect(proseScore.invalidOutputs[0]).toStartWith("invalid_final_envelope:");

    const unknown = finalEnvelopeFixture();
    unknown.claims.push({
      claimKey: "answerText",
      value: { type: "string", value: "INC-4827" },
      citations: [evidence()],
    });
    const unknownScore = scoreTrajectory(
      taskFixture(),
      oracleFixture(),
      receipt,
      unknown
    );
    expect(unknownScore.invalidOutputs).toContain("extra_claim:answerText");
    expect(unknownScore.success).toBe(0);
  });

  test("scores collection filters and unnecessary reads separately", () => {
    const receipt = receiptFixture();
    const firstCall = receipt.canonical.calls[0];
    if (!firstCall) throw new Error("call missing");
    firstCall.arguments = { query: "incident", collection: "c002" };
    receipt.canonical.calls = Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(firstCall),
      callIndex: index,
    }));
    receipt.canonical.agentCalls = 4;
    receipt.canonical.backendInvocations = 4;
    receipt.canonical.modelVisibleUtf8Bytes =
      firstCall.modelVisibleUtf8Bytes * receipt.canonical.calls.length;
    const score = scoreTrajectory(taskFixture(), oracleFixture(), receipt);
    expect(score.collectionCorrect).toBe(false);
    expect(score.unnecessaryRead).toBe(true);
    expect(score.completed).toBe(true);
    expect(score.success).toBe(0);
  });

  test("fails inconsistent call and backend accounting", () => {
    const receipt = receiptFixture();
    receipt.canonical.agentCalls = 2;
    receipt.canonical.backendInvocations = 9;
    receipt.canonical.modelVisibleUtf8Bytes = 999;
    const score = scoreTrajectory(taskFixture(), oracleFixture(), receipt);
    expect(score.invalidOutputs).toEqual(
      expect.arrayContaining([
        "agent_calls_mismatch",
        "backend_invocations_mismatch",
        "model_visible_bytes_mismatch",
      ])
    );
    expect(score.success).toBe(0);
  });

  test("keeps harness failures visible and unscored", () => {
    const receipt = receiptFixture(evidence(), {
      failure: {
        class: "harness_error",
        code: "FIXTURE_INVALID",
        redactedMessage: "fixture failed",
      },
      finalEnvelope: null,
      stopReason: "error",
    });
    const score = scoreTrajectory(
      taskFixture(),
      oracleFixture(),
      receipt,
      finalEnvelopeFixture()
    );
    expect(score.scored).toBe(false);
    expect(score.exclusionReason).toBe("harness_error");
    expect(score.success).toBe(0);
  });
});

const successfulScore = (receipt: TrajectoryReceipt) => ({
  taskId: receipt.canonical.taskId,
  scored: true,
  exclusionReason: null,
  success: 1 as const,
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

const promotionPair = (
  baselineCalls = 4,
  candidateCalls = 3,
  baselineBytes = 100,
  candidateBytes = 65
): PromotionPair => {
  const baselineReceipt = receiptFixture(evidence(), {
    adapterId: "gno-mcp",
    agentCalls: baselineCalls,
    modelVisibleUtf8Bytes: baselineBytes,
  });
  const candidateReceipt = receiptFixture(evidence(), {
    adapterId: "capsule",
    agentCalls: candidateCalls,
    modelVisibleUtf8Bytes: candidateBytes,
  });
  const payload = productionCapsuleProjectionFixture(
    candidateReceipt.canonical.taskId
  );
  const candidateCall = candidateReceipt.canonical.calls[0];
  if (!candidateCall) throw new Error("Promotion fixture requires one call");
  candidateCall.result.resultRole = "evidence_bundle";
  candidateCall.result.content = payload;
  const replay = {
    taskId: candidateReceipt.canonical.taskId,
    adapterId: "capsule" as const,
    trialId: candidateReceipt.canonical.trialId,
    seed: candidateReceipt.canonical.seed,
    lifecycle: candidateReceipt.canonical.lifecycle,
    agentId: candidateReceipt.canonical.agentId,
    first: { canonicalJson: payload, sha256: sha256Bytes(payload) },
    second: { canonicalJson: payload, sha256: sha256Bytes(payload) },
  };
  return {
    taskId: baselineReceipt.canonical.taskId,
    trialId: baselineReceipt.canonical.trialId,
    lifecycle: baselineReceipt.canonical.lifecycle,
    baseline: {
      receipt: baselineReceipt,
      score: scoreRecordFor(baselineReceipt, successfulScore(baselineReceipt)),
    },
    candidate: {
      receipt: candidateReceipt,
      score: scoreRecordFor(
        candidateReceipt,
        successfulScore(candidateReceipt)
      ),
      replay,
    },
  };
};

describe("Capsule promotion formulas", () => {
  test("passes exact pairwise aggregate and efficiency thresholds", () => {
    const result = evaluatePromotionGates([promotionPair()]);
    expect(result.passed).toBe(true);
    expect(result.metrics).toEqual({
      baselineSuccessRate: 1,
      candidateSuccessRate: 1,
      agentCallReduction: 0.25,
      contextByteReduction: 0.35,
      claimLinkageRate: 1,
    });
  });

  test("fails pairwise loss even when aggregate could tie", () => {
    const first = promotionPair();
    first.candidate.score.score.success = 0;
    const second = promotionPair();
    second.taskId = "t1b2c3d4";
    second.baseline.receipt.canonical.taskId = second.taskId;
    second.candidate.receipt.canonical.taskId = second.taskId;
    second.baseline.score.taskId = second.taskId;
    second.baseline.score.score.taskId = second.taskId;
    second.candidate.score.taskId = second.taskId;
    second.candidate.score.score.taskId = second.taskId;
    second.candidate.replay.taskId = second.taskId;
    const changedPayload = productionCapsuleProjectionFixture(second.taskId);
    second.candidate.replay.first = {
      canonicalJson: changedPayload,
      sha256: sha256Bytes(changedPayload),
    };
    second.candidate.replay.second = second.candidate.replay.first;
    second.candidate.receipt.canonical.calls[0]!.result.content =
      changedPayload;
    second.baseline.score.score.success = 0;
    const result = evaluatePromotionGates([first, second]);
    expect(result.passed).toBe(false);
    expect(
      result.failures.some((failure) =>
        failure.startsWith("pairwise_accuracy_loss:")
      )
    ).toBe(true);
  });

  test("fails zero denominators and nondeterministic payloads", () => {
    const pair = promotionPair(0, 0, 0, 0);
    const changed = productionCapsuleProjectionFixture(`${pair.taskId}-2`);
    pair.candidate.replay.second.canonicalJson = changed;
    pair.candidate.replay.second.sha256 = sha256Bytes(changed);
    pair.candidate.score.score.substantiveClaims = 0;
    pair.candidate.score.score.linkedSupportedClaims = 0;
    const result = evaluatePromotionGates([pair]);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "agent_call_reduction_below_0.25_or_zero_denominator"
    );
    expect(result.failures).toContain(
      "context_byte_reduction_below_0.35_or_zero_denominator"
    );
    expect(result.failures).toContain(
      "claim_linkage_below_0.95_or_zero_denominator"
    );
    expect(
      result.failures.some((failure) =>
        failure.startsWith("nondeterministic_capsule_payload:")
      )
    ).toBe(true);
  });

  test("requires identical unique paired cohorts", () => {
    const baselineReceipt = receiptFixture();
    const baseline: ScoredReceipt[] = [
      {
        receipt: baselineReceipt,
        score: scoreRecordFor(
          baselineReceipt,
          successfulScore(baselineReceipt)
        ),
      },
    ];
    const candidateReceipt = receiptFixture(evidence(), {
      taskId: "t1b2c3d4",
      adapterId: "capsule",
    });
    const candidate = [
      {
        receipt: candidateReceipt,
        score: scoreRecordFor(
          candidateReceipt,
          successfulScore(candidateReceipt)
        ),
        replay: promotionPair().candidate.replay,
      },
    ];
    expect(() => pairPromotionCohorts(baseline, candidate)).toThrow(
      "identical pairs"
    );
    expect(() => pairPromotionCohorts([...baseline, ...baseline], [])).toThrow(
      "duplicate"
    );
  });
});
