import { describe, expect, test } from "bun:test";

import baseline from "../../evals/fixtures/cjk-lexical-benchmark/2026-07-22.json";
import gates from "../../evals/fixtures/cjk-lexical-benchmark/promotion-gates.json";
import qrels from "../../evals/fixtures/cjk-lexical-benchmark/qrels.json";

const LANGUAGES = ["zh", "ja", "ko"] as const;
const QUALITY_METRICS = ["recallAt5", "recallAt10", "mrr", "ndcgAt10"] as const;

describe("CJK lexical promotion gates", () => {
  test("binds to the immutable dated production baseline", async () => {
    const latest = await Bun.file(
      "evals/fixtures/cjk-lexical-benchmark/latest.json"
    ).json();

    expect(gates.baseline.artifact).toBe("2026-07-22.json");
    expect(gates.baseline.resultFingerprint).toBe(baseline.fingerprints.result);
    expect(gates.baseline.configFingerprint).toBe(baseline.fingerprints.config);
    expect(gates.baseline.tokenizerFingerprint).toBe(
      baseline.fingerprints.tokenizer
    );
    expect(latest.fingerprints.result).toBe(baseline.fingerprints.result);
    expect(gates.baseline.lane).toBe("bm25");
  });

  test("freezes per-language recall and ranking lifts", () => {
    const lane = baseline.lanes.find(
      (candidate) => candidate.id === gates.baseline.lane
    );
    expect(lane).toBeDefined();

    for (const language of LANGUAGES) {
      const measured = lane?.languages.find(
        (candidate) => candidate.language === language
      );
      const gate = gates.quality.languages[language];
      if (!measured) {
        throw new Error(`Missing ${language} baseline metrics`);
      }
      expect(measured.queryCount).toBe(gates.baseline.queryCountPerLanguage);
      expect(gate.baseline).toEqual(measured.metrics);

      for (const metric of QUALITY_METRICS) {
        expect(gate.minimumCandidate[metric] - gate.baseline[metric]).toBe(
          gates.quality.minimumAbsoluteMetricLift
        );
      }
      expect(
        gate.baseline.zeroResultRate - gate.minimumCandidate.zeroResultRate
      ).toBe(gates.quality.minimumAbsoluteMetricLift);
      expect(
        gates.quality.minimumAbsoluteMetricLift *
          gates.baseline.queryCountPerLanguage
      ).toBe(gates.quality.minimumAdditionalRecallHitsPerLanguage);
    }
  });

  test("covers each concrete baseline failure class", () => {
    const lane = baseline.lanes.find(({ id }) => id === "bm25");
    const failures = lane?.languages.flatMap((language) => language.failures);
    expect(failures).toBeDefined();

    for (const category of gates.failureCoverage.requiredCategories) {
      const examples =
        gates.failureCoverage.baselineExamples[
          category as keyof typeof gates.failureCoverage.baselineExamples
        ];
      expect(examples.length).toBeGreaterThan(0);
      for (const queryId of examples) {
        expect(failures).toContainEqual(
          expect.objectContaining({ queryId, category })
        );
      }
    }
  });

  test("records qrels and non-regression limitations without choosing an analyzer", () => {
    const positiveGrades = [
      ...new Set(
        qrels.judgments
          .filter(({ relevance }) => relevance > 0)
          .map(({ relevance }) => relevance)
      ),
    ];
    expect(positiveGrades).toEqual(gates.baseline.positiveQrelGrades);
    expect(gates.baseline.qrelsLimitation).toContain(
      "not distinctions among positive gain grades"
    );
    expect(gates.nonRegression.latinAndCode).toEqual({
      maximumAbsoluteRecallAt10Loss: 0.02,
      maximumAbsoluteNdcgAt10Loss: 0.02,
    });
    expect(gates.nonRegression.identifiers).toEqual({
      maximumPreviouslyPassingQueriesLost: 0,
      maximumNewZeroResultQueries: 0,
    });
    expect(gates.decisionRule).toContain("any deterministic representation");
    expect(gates.decisionRule).toContain("no-ship");
    expect(gates.decisionRule).not.toMatch(
      /must (?:use|select)|selected analyzer|chosen tokenizer/i
    );
  });

  test("freezes bounded index, build, and warm-query costs", () => {
    expect(gates.cost.indexBytes.baseline).toBe(baseline.index.bytes);
    expect(gates.cost.indexBytes.datedRunMaximumBytes).toBe(
      baseline.index.bytes * gates.cost.indexBytes.maximumRatio
    );
    expect(gates.cost.buildMs.baseline).toBe(baseline.index.buildMs);
    expect(gates.cost.buildMs.datedRunMaximumMs).toBe(
      baseline.index.buildMs * gates.cost.buildMs.maximumRatio
    );

    const bm25 = baseline.lanes.find(({ id }) => id === "bm25");
    if (!bm25) {
      throw new Error("Missing BM25 baseline lane");
    }
    expect(gates.cost.warmQueryP95Ms.baseline).toBe(
      bm25.latency.warmQuery.p95Ms
    );
    expect(gates.cost.warmQueryP95Ms.datedRunRatioMaximumMs).toBeCloseTo(
      gates.cost.warmQueryP95Ms.baseline *
        gates.cost.warmQueryP95Ms.maximumRatio
    );
  });
});
