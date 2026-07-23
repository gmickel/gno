import { describe, expect, test } from "bun:test";

import type {
  VerifiedAskOutcomeReceipt,
  VerifiedAskPromotionArtifact,
} from "../../../evals/agentic/verified-ask-outcome";

import { canonicalFingerprint } from "../../../evals/agentic/canonical";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  encodeVerifiedAskClaim,
  evaluateVerifiedAskPromotion,
  runVerifiedAskOutcomeBenchmark,
  verifiedAskArtifactFingerprint,
  validateVerifiedAskPromotionArtifact,
} from "../../../evals/agentic/verified-ask-outcome";

const CLEAN_GIT = { commit: "0".repeat(40), dirty: false } as const;

const reseal = (receipt: VerifiedAskOutcomeReceipt): void => {
  receipt.answerFingerprint = canonicalFingerprint(receipt.answer);
  const { canonicalFingerprint: _old, ...canonical } = receipt;
  receipt.canonicalFingerprint = canonicalFingerprint(canonical);
};

const resealArtifact = (artifact: VerifiedAskPromotionArtifact): void => {
  const { canonicalFingerprint: _old, ...projection } = artifact;
  artifact.canonicalFingerprint = verifiedAskArtifactFingerprint(projection);
};

const setup = async () => {
  const fixture = await loadAgenticFixture();
  const artifact = await runVerifiedAskOutcomeBenchmark(fixture, {
    git: CLEAN_GIT,
  });
  return { artifact, fixture };
};

describe("verified Ask outcome promotion", () => {
  test("pairs production raw Ask with production verified Ask", async () => {
    const { artifact } = await setup();

    expect(artifact.excludedTasks).toEqual([
      { taskId: "t234cd5e", reason: "expected_missing_evidence" },
      { taskId: "t345de6f", reason: "expected_missing_evidence" },
    ]);
    expect(artifact.receipts).toHaveLength(44);
    expect(artifact.scores).toHaveLength(44);
    expect(artifact.environment.git).toEqual(CLEAN_GIT);
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
        abstained: true,
        citations: [],
        verification: { requested: true, answerStatus: "abstained" },
      });
    }
  });

  test("derives scores from final answers and rejects forged output", async () => {
    const { artifact, fixture } = await setup();
    const receipts = structuredClone(artifact.receipts);
    const verified = receipts.find(
      (receipt) =>
        receipt.taskId === "t012ab3c" && receipt.lane === "verified_ask"
    )!;
    const evidenceSuffix = verified.answer.slice(
      verified.answer.indexOf("[evidence:")
    );
    verified.answer = `${encodeVerifiedAskClaim("automaticExport", {
      type: "boolean",
      value: false,
    })} ${evidenceSuffix}`;
    reseal(verified);

    const result = evaluateVerifiedAskPromotion(
      receipts,
      artifact.scores,
      fixture.oracles
    );
    expect(result.passed).toBeFalse();
    expect(result.pairCount).toBe(0);
    expect(result.failures).toContainEqual(
      expect.stringContaining("score_receipt_mismatch:verified_ask")
    );
  });

  test("fails closed for semantics, fingerprints, scores, and pair identity", async () => {
    const { artifact, fixture } = await setup();
    const expectInvalid = (
      receipts = artifact.receipts,
      scores = artifact.scores
    ) => {
      const result = evaluateVerifiedAskPromotion(
        receipts,
        scores,
        fixture.oracles
      );
      expect(result.passed).toBeFalse();
      expect(result.pairCount).toBe(0);
      expect(result.metrics.baselineAnswerAccuracy).toBeNull();
    };

    const semantics = structuredClone(artifact.receipts);
    const verified = semantics.find(
      (receipt) => receipt.lane === "verified_ask" && !receipt.abstained
    )!;
    verified.verification = { requested: false, answerStatus: "raw" };
    reseal(verified);
    expectInvalid(semantics);

    const badReceiptFingerprint = structuredClone(artifact.receipts);
    badReceiptFingerprint[0]!.canonicalFingerprint = "0".repeat(64);
    expectInvalid(badReceiptFingerprint);

    const badAnswerFingerprint = structuredClone(artifact.receipts);
    badAnswerFingerprint[0]!.answerFingerprint = "0".repeat(64);
    const { canonicalFingerprint: _old, ...canonical } =
      badAnswerFingerprint[0]!;
    badAnswerFingerprint[0]!.canonicalFingerprint =
      canonicalFingerprint(canonical);
    expectInvalid(badAnswerFingerprint);

    const alteredScores = structuredClone(artifact.scores);
    alteredScores[0]!.answerAccuracy =
      alteredScores[0]!.answerAccuracy === 1 ? 0 : 1;
    expectInvalid(artifact.receipts, alteredScores);

    const duplicate = structuredClone(artifact.receipts);
    duplicate.push(structuredClone(duplicate[0]!));
    expectInvalid(duplicate);

    const missing = structuredClone(artifact.receipts);
    missing.pop();
    expectInvalid(missing);
  });

  test("validates artifact fingerprint and clean provenance", async () => {
    const { artifact, fixture } = await setup();
    expect(
      validateVerifiedAskPromotionArtifact(artifact, fixture.oracles)
    ).toEqual([]);

    const dirty = structuredClone(artifact);
    dirty.environment.git.dirty = true;
    expect(
      validateVerifiedAskPromotionArtifact(dirty, fixture.oracles)
    ).toContain("artifact_git_provenance_invalid");

    const badFingerprint = structuredClone(artifact);
    badFingerprint.canonicalFingerprint = "0".repeat(64);
    expect(
      validateVerifiedAskPromotionArtifact(badFingerprint, fixture.oracles)
    ).toContain("artifact_fingerprint_mismatch");

    let dirtyError: unknown;
    try {
      await runVerifiedAskOutcomeBenchmark(fixture, {
        git: { commit: "0".repeat(40), dirty: true },
      });
    } catch (error) {
      dirtyError = error;
    }
    expect(dirtyError).toBeInstanceOf(Error);
    expect((dirtyError as Error).message).toContain("clean Git checkout");
  });

  test("rejects a complete removed pair even after promotion and artifact resealing", async () => {
    const { artifact, fixture } = await setup();
    const removedTaskId = "t012ab3c";
    artifact.receipts = artifact.receipts.filter(
      ({ taskId }) => taskId !== removedTaskId
    );
    artifact.scores = artifact.scores.filter(
      ({ taskId }) => taskId !== removedTaskId
    );
    artifact.promotion = evaluateVerifiedAskPromotion(
      artifact.receipts,
      artifact.scores,
      fixture.oracles
    );
    resealArtifact(artifact);

    expect(artifact.promotion.pairCount).toBe(0);
    expect(artifact.promotion.failures).toContain(
      "compatible_task_set_mismatch:raw_ask"
    );
    expect(
      validateVerifiedAskPromotionArtifact(artifact, fixture.oracles)
    ).toContain("artifact_cohort_contract_mismatch");
  });

  test("rejects trailing unsupported prose after every fingerprint is resealed", async () => {
    const { artifact, fixture } = await setup();
    const verified = artifact.receipts.find(
      (receipt) => receipt.lane === "verified_ask" && !receipt.abstained
    )!;
    verified.answer += " Bogus unsupported sentence.";
    reseal(verified);
    artifact.promotion = evaluateVerifiedAskPromotion(
      artifact.receipts,
      artifact.scores,
      fixture.oracles
    );
    resealArtifact(artifact);

    expect(artifact.promotion.pairCount).toBe(0);
    expect(artifact.promotion.failures).toContainEqual(
      expect.stringContaining("answer_claim_unparseable:verified_ask")
    );
    expect(
      validateVerifiedAskPromotionArtifact(artifact, fixture.oracles)
    ).toContain("artifact_promotion_failed");
  });
});
