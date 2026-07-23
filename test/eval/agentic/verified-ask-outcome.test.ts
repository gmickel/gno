import { describe, expect, test } from "bun:test";

import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  evaluateVerifiedAskPromotion,
  runVerifiedAskOutcomeBenchmark,
} from "../../../evals/agentic/verified-ask-outcome";

describe("verified Ask outcome promotion", () => {
  test("pairs production raw Ask with production verified Ask", async () => {
    const artifact = await runVerifiedAskOutcomeBenchmark(
      await loadAgenticFixture()
    );

    expect(artifact.excludedTasks).toEqual([
      {
        taskId: "t234cd5e",
        reason: "expected_missing_evidence",
      },
      {
        taskId: "t345de6f",
        reason: "expected_missing_evidence",
      },
    ]);
    expect(artifact.receipts).toHaveLength(44);
    expect(artifact.scores).toHaveLength(44);
    expect(artifact.environment.git).toMatchObject({
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(artifact.promotion).toEqual({
      passed: true,
      pairCount: 22,
      failures: [],
      metrics: {
        baselineAnswerAccuracy: 18 / 22,
        candidateAnswerAccuracy: 18 / 22,
        baselineUnsupportedSubstantiveClaims: 4,
        candidateUnsupportedSubstantiveClaims: 0,
        unsupportedSubstantiveClaimReduction: 1,
      },
    });

    for (const taskId of ["t0a1b2c3", "t6071829", "t8293a4b", "te8f901a"]) {
      expect(
        artifact.receipts.find(
          (receipt) => receipt.taskId === taskId && receipt.lane === "raw_ask"
        )
      ).toMatchObject({
        draftKind: "adversarial",
        abstained: false,
        verification: { requested: false, answerStatus: "raw" },
      });
      expect(
        artifact.receipts.find(
          (receipt) =>
            receipt.taskId === taskId && receipt.lane === "verified_ask"
        )
      ).toMatchObject({
        draftKind: "adversarial",
        declaredClaim: null,
        abstained: true,
        citations: [],
        verification: { requested: true, answerStatus: "abstained" },
      });
    }
  });

  test("fails closed for duplicate, missing, and mismatched pairs", async () => {
    const artifact = await runVerifiedAskOutcomeBenchmark(
      await loadAgenticFixture()
    );
    const duplicate = structuredClone(artifact.receipts);
    duplicate.push(structuredClone(duplicate[0]!));
    expect(
      evaluateVerifiedAskPromotion(duplicate, artifact.scores)
    ).toMatchObject({
      passed: false,
      pairCount: 0,
      metrics: {
        baselineAnswerAccuracy: null,
        candidateAnswerAccuracy: null,
      },
    });

    const missing = structuredClone(artifact.receipts);
    missing.pop();
    expect(
      evaluateVerifiedAskPromotion(missing, artifact.scores)
    ).toMatchObject({
      passed: false,
      pairCount: 0,
    });

    const mismatched = structuredClone(artifact.receipts);
    mismatched.find(
      (receipt) => receipt.lane === "verified_ask"
    )!.requestFingerprint = "f".repeat(64);
    expect(
      evaluateVerifiedAskPromotion(mismatched, artifact.scores)
    ).toMatchObject({
      passed: false,
      pairCount: 0,
    });
  });
});
