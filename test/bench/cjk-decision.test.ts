import { describe, expect, test } from "bun:test";

import baseline from "../../evals/fixtures/cjk-lexical-benchmark/2026-07-22.json";
import decision from "../../evals/fixtures/cjk-lexical-benchmark/candidates/2026-07-22-no-ship.json";
import gates from "../../evals/fixtures/cjk-lexical-benchmark/promotion-gates.json";

const LANGUAGES = ["zh", "ja", "ko"] as const;
const QUALITY_METRICS = ["recallAt5", "recallAt10", "mrr", "ndcgAt10"] as const;
const CANDIDATE_IDS = ["substring-raw", "substring-nfc"] as const;

const sha256 = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
};

describe("fn-109 CJK lexical no-ship decision", () => {
  test("binds the receipt to immutable fn-96 evidence", async () => {
    expect(decision.inputs.baseline).toMatchObject({
      artifact: "../2026-07-22.json",
      resultFingerprint: baseline.fingerprints.result,
      configFingerprint: baseline.fingerprints.config,
      tokenizerFingerprint: baseline.fingerprints.tokenizer,
    });
    expect(decision.inputs.baseline.sha256).toBe(
      await sha256("evals/fixtures/cjk-lexical-benchmark/2026-07-22.json")
    );
    expect(decision.inputs.promotionGates.sha256).toBe(
      await sha256("evals/fixtures/cjk-lexical-benchmark/promotion-gates.json")
    );
    expect(decision.inputs.qrelsLimitation).toBe(
      gates.baseline.qrelsLimitation
    );
  });

  test("does not weaken any frozen language, non-regression, or cost threshold", () => {
    expect(gates.quality.languages).toEqual({
      zh: {
        baseline: {
          recallAt5: 0.1111,
          recallAt10: 0.2222,
          mrr: 0.127,
          ndcgAt10: 0.1481,
          zeroResultRate: 0.7778,
        },
        minimumCandidate: {
          recallAt5: 0.3611,
          recallAt10: 0.4722,
          mrr: 0.377,
          ndcgAt10: 0.3981,
          zeroResultRate: 0.5278,
        },
      },
      ja: {
        baseline: {
          recallAt5: 0.125,
          recallAt10: 0.125,
          mrr: 0.125,
          ndcgAt10: 0.125,
          zeroResultRate: 0.875,
        },
        minimumCandidate: {
          recallAt5: 0.375,
          recallAt10: 0.375,
          mrr: 0.375,
          ndcgAt10: 0.375,
          zeroResultRate: 0.625,
        },
      },
      ko: {
        baseline: {
          recallAt5: 0.5,
          recallAt10: 0.5,
          mrr: 0.5,
          ndcgAt10: 0.5,
          zeroResultRate: 0.5,
        },
        minimumCandidate: {
          recallAt5: 0.75,
          recallAt10: 0.75,
          mrr: 0.75,
          ndcgAt10: 0.75,
          zeroResultRate: 0.25,
        },
      },
    });
    expect(gates.quality.minimumAdditionalRecallHitsPerLanguage).toEqual({
      zh: 3,
      ja: 2,
      ko: 2,
    });
    expect(gates.nonRegression.latinAndCode).toEqual({
      maximumAbsoluteRecallAt10Loss: 0.02,
      maximumAbsoluteNdcgAt10Loss: 0.02,
    });
    expect(gates.nonRegression.identifiers).toEqual({
      maximumPreviouslyPassingQueriesLost: 0,
      maximumNewZeroResultQueries: 0,
    });
    expect(gates.cost.indexBytes.maximumRatio).toBe(1.75);
    expect(gates.cost.buildMs.maximumRatio).toBe(2);
    expect(gates.cost.warmQueryP95Ms).toMatchObject({
      maximumRatio: 3,
      maximumAbsoluteIncreaseMs: 2,
    });
    expect(decision.decision.thresholdsWeakened).toBe(false);

    for (const candidate of decision.candidates) {
      for (const language of LANGUAGES) {
        expect(candidate.quality.languages[language].minimum).toEqual(
          gates.quality.languages[language].minimumCandidate
        );
        expect(
          candidate.quality.languages[language].additionalRecallHits.minimum
        ).toBe(gates.quality.minimumAdditionalRecallHitsPerLanguage[language]);
      }
      expect(candidate.nonRegression.latinAndCode).toMatchObject(
        gates.nonRegression.latinAndCode
      );
      expect(candidate.nonRegression.identifiers).toMatchObject(
        gates.nonRegression.identifiers
      );
      expect(candidate.cost.indexBytes.maximumRatio).toBe(
        gates.cost.indexBytes.maximumRatio
      );
      expect(candidate.cost.indexBytes.datedRunMaximumBytes).toBe(
        gates.cost.indexBytes.datedRunMaximumBytes
      );
      expect(candidate.cost.buildMs.maximumRatio).toBe(
        gates.cost.buildMs.maximumRatio
      );
      expect(candidate.cost.buildMs.datedRunMaximumMs).toBe(
        gates.cost.buildMs.datedRunMaximumMs
      );
      expect(candidate.cost.warmQueryP95Ms).toMatchObject({
        baselineMs: gates.cost.warmQueryP95Ms.baseline,
        maximumRatio: gates.cost.warmQueryP95Ms.maximumRatio,
        maximumAbsoluteIncreaseMs:
          gates.cost.warmQueryP95Ms.maximumAbsoluteIncreaseMs,
      });
    }
  });

  test("evaluates every language metric against its independent gate", () => {
    for (const candidateId of CANDIDATE_IDS) {
      const candidate = decision.candidates.find(
        ({ id }) => id === candidateId
      );
      const lane = baseline.lanes.find(({ id }) => id === candidateId);
      if (!(candidate && lane)) {
        throw new Error(`Missing committed candidate evidence: ${candidateId}`);
      }

      for (const language of LANGUAGES) {
        const measured = lane.languages.find(
          (entry) => entry.language === language
        );
        if (!measured) {
          throw new Error(`Missing ${candidateId}/${language} metrics`);
        }
        const evaluation = candidate.quality.languages[language];
        const frozen = gates.quality.languages[language];

        expect(evaluation.queryCount).toBe(
          gates.baseline.queryCounts[language]
        );
        expect(evaluation.measured).toEqual(measured.metrics);
        for (const metric of QUALITY_METRICS) {
          expect(evaluation.checks[metric]).toBe(
            measured.metrics[metric] >= frozen.minimumCandidate[metric]
          );
        }
        expect(evaluation.checks.zeroResultRate).toBe(
          measured.metrics.zeroResultRate <=
            frozen.minimumCandidate.zeroResultRate
        );

        const baselineHits = Math.round(
          frozen.baseline.recallAt10 * evaluation.queryCount
        );
        const candidateHits = Math.round(
          measured.metrics.recallAt10 * evaluation.queryCount
        );
        expect(evaluation.additionalRecallHits.measured).toBe(
          candidateHits - baselineHits
        );
        expect(evaluation.additionalRecallHits.pass).toBe(
          evaluation.additionalRecallHits.measured >=
            evaluation.additionalRecallHits.minimum
        );
        expect(evaluation.pass).toBe(
          Object.values(evaluation.checks).every(Boolean) &&
            evaluation.additionalRecallHits.pass
        );
      }

      expect(candidate.quality.pass).toBe(
        LANGUAGES.every(
          (language) => candidate.quality.languages[language].pass
        )
      );
    }
  });

  test("preserves every concrete failure category and recovery result", () => {
    expect(decision.gateCoverage).toEqual([
      "quality.languages",
      "quality.minimumAdditionalRecallHitsPerLanguage",
      "failureCoverage",
      "nonRegression.latinAndCode",
      "nonRegression.identifiers",
      "nonRegression.requiredSuites",
      "cost.indexBytes",
      "cost.buildMs",
      "cost.warmQueryP95Ms",
      "crossPlatformVariance",
      "rollbackFeasibility",
      "selectionEligibility",
    ]);

    for (const candidate of decision.candidates) {
      const lane = baseline.lanes.find(
        ({ id }) => id === candidate.evidenceLane
      );
      if (!lane) {
        throw new Error(`Missing evidence lane: ${candidate.evidenceLane}`);
      }

      expect(Object.keys(candidate.failureCoverage.categories)).toEqual(
        gates.failureCoverage.requiredCategories
      );
      for (const category of gates.failureCoverage.requiredCategories) {
        const key =
          category as keyof typeof candidate.failureCoverage.categories;
        const evaluation = candidate.failureCoverage.categories[key];
        const frozenExamples =
          gates.failureCoverage.baselineExamples[
            category as keyof typeof gates.failureCoverage.baselineExamples
          ];
        const recovered = frozenExamples.filter((queryId) => {
          const benchmarkCase = lane.cases.find(
            (entry) => entry.queryId === queryId
          );
          return (benchmarkCase?.metrics.recallAt10 ?? 0) > 0;
        });

        expect(evaluation.baselineExamples).toEqual(frozenExamples);
        expect(evaluation.recoveredExamples).toEqual(recovered);
        expect(evaluation.pass).toBe(
          recovered.length === frozenExamples.length
        );
      }
      expect(candidate.failureCoverage.pass).toBe(
        Object.values(candidate.failureCoverage.categories).every(
          ({ pass }) => pass
        )
      );
    }
  });

  test("fails closed on missing production evidence and selects nothing", async () => {
    for (const candidate of decision.candidates) {
      expect(candidate.classification).toBe("benchmark-diagnostic-only");
      expect(candidate.eligibleForSelection).toBe(false);
      expect(candidate.nonRegression).toMatchObject({
        comparison: "not-measured",
        pass: false,
      });
      expect(candidate.nonRegression.latinAndCode).toMatchObject({
        status: "not-measured",
        pass: false,
      });
      expect(candidate.nonRegression.identifiers).toMatchObject({
        status: "not-measured",
        pass: false,
      });
      expect(candidate.nonRegression.requiredSuites).toMatchObject({
        commands: gates.nonRegression.requiredSuites,
        status: "not-run-for-diagnostic",
        pass: false,
      });
      expect(candidate.cost.indexBytes).toMatchObject({
        status: "not-measured",
        pass: false,
      });
      expect(candidate.cost.buildMs).toMatchObject({
        status: "not-measured",
        pass: false,
      });
      const lane = baseline.lanes.find(
        ({ id }) => id === candidate.evidenceLane
      );
      if (!lane) {
        throw new Error(`Missing evidence lane: ${candidate.evidenceLane}`);
      }
      expect(candidate.cost.warmQueryP95Ms.measuredMs).toBe(
        lane.latency.warmQuery.p95Ms
      );
      expect(candidate.cost.warmQueryP95Ms.measuredRatio).toBeCloseTo(
        lane.latency.warmQuery.p95Ms / gates.cost.warmQueryP95Ms.baseline,
        4
      );
      expect(candidate.cost.warmQueryP95Ms.absoluteIncreaseMs).toBeCloseTo(
        lane.latency.warmQuery.p95Ms - gates.cost.warmQueryP95Ms.baseline
      );
      expect(candidate.cost.warmQueryP95Ms.pass).toBe(true);
      expect(candidate.cost.pass).toBe(false);
      expect(candidate.crossPlatformVariance).toEqual({
        status: "not-measured",
        pass: false,
      });
      expect(candidate.rollbackFeasibility).toEqual({
        status: "not-applicable-diagnostic-only",
        pass: false,
      });
      expect(candidate.failedGates).toContain("quality.zh.recallAt10");
      expect(candidate.failedGates).toContain("quality.zh.zeroResultRate");
      expect(candidate.failedGates).toContain("rollbackFeasibility");
      expect(candidate.passesAllRequiredGates).toBe(false);
    }

    expect(decision.outcome).toBe("no-ship");
    expect(decision.selectedRepresentation).toBeNull();
    expect(decision.decision.productionChangesAuthorized).toBe(false);
    expect(decision.decision.downstreamTasks).toEqual({
      execute: false,
      ids: [
        "fn-109-cjk-lexical-normalization.2",
        "fn-109-cjk-lexical-normalization.3",
        "fn-109-cjk-lexical-normalization.4",
      ],
      reason:
        "The fn-109 early proof point failed; production schema, analyzer, migration, packaging, and public support claims remain out of scope.",
    });

    const markdown = await Bun.file(
      "evals/fixtures/cjk-lexical-benchmark/decision.md"
    ).text();
    expect(markdown).toContain("Decision: **no ship**");
    expect(markdown).toContain("0.4444 / 0.4722");
    expect(markdown).toContain("0.5556 / 0.5278");
    expect(markdown).toContain("must not execute");
  });
});
