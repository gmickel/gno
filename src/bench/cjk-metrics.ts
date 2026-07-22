import type {
  CjkBenchCaseResult,
  CjkBenchFailure,
  CjkBenchLanguage,
  CjkBenchLanguageResult,
  CjkBenchMetrics,
} from "./types";

import { computeMrr, computeNdcg, computeRecall } from "./metrics";

const round = (value: number, places = 4): number =>
  Number(value.toFixed(places));

const average = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

export const summarizeLatency = (
  values: number[]
): { p50Ms: number; p95Ms: number; meanMs: number } => {
  if (values.length === 0) {
    return { p50Ms: 0, p95Ms: 0, meanMs: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (percent: number): number => {
    const index = Math.ceil((percent / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
  };
  return {
    p50Ms: round(percentile(50), 2),
    p95Ms: round(percentile(95), 2),
    meanMs: round(average(values), 2),
  };
};

export const buildCjkCaseResult = (input: {
  queryId: string;
  language: CjkBenchLanguage;
  category: CjkBenchCaseResult["category"];
  query: string;
  expected: string[];
  judgments: Array<{ docid: string; relevance: number }>;
  topDocs: string[];
  warmLatencyMs: number;
  error?: string;
}): CjkBenchCaseResult => ({
  queryId: input.queryId,
  language: input.language,
  category: input.category,
  query: input.query,
  expected: input.expected,
  topDocs: input.topDocs.slice(0, 10),
  metrics: {
    recallAt5: round(computeRecall(input.topDocs, input.expected, 5)),
    recallAt10: round(computeRecall(input.topDocs, input.expected, 10)),
    mrr: round(computeMrr(input.topDocs, input.expected)),
    ndcgAt10: round(computeNdcg(input.topDocs, input.judgments, 10)),
  },
  zeroResult: input.topDocs.length === 0,
  warmLatencyMs: round(input.warmLatencyMs, 2),
  ...(input.error ? { error: input.error } : {}),
});

export const summarizeCjkMetrics = (
  cases: CjkBenchCaseResult[]
): CjkBenchMetrics => ({
  recallAt5: round(average(cases.map((item) => item.metrics.recallAt5))),
  recallAt10: round(average(cases.map((item) => item.metrics.recallAt10))),
  mrr: round(average(cases.map((item) => item.metrics.mrr))),
  ndcgAt10: round(average(cases.map((item) => item.metrics.ndcgAt10))),
  zeroResultRate: round(
    average(cases.map((item) => (item.zeroResult ? 1 : 0)))
  ),
});

export const classifyCjkFailures = (
  cases: CjkBenchCaseResult[]
): CjkBenchFailure[] =>
  cases.flatMap((item) => {
    if (item.metrics.recallAt5 === 1) {
      return [];
    }
    const reason = item.zeroResult
      ? "zero-result"
      : item.metrics.recallAt10 === 0
        ? "not-in-top-10"
        : "below-rank-5";
    const diagnosticCategories = new Set([
      "identifier",
      "mixed-script",
      "normalization",
      "token-boundary",
    ]);
    return [
      {
        queryId: item.queryId,
        language: item.language,
        category: diagnosticCategories.has(item.category)
          ? item.category
          : "ranking",
        reason,
        query: item.query,
        expected: item.expected,
        topDocs: item.topDocs.slice(0, 5),
      },
    ];
  });

export const summarizeCjkLanguage = (
  language: CjkBenchLanguage,
  cases: CjkBenchCaseResult[]
): CjkBenchLanguageResult => ({
  language,
  queryCount: cases.length,
  metrics: summarizeCjkMetrics(cases),
  failures: classifyCjkFailures(cases),
});
