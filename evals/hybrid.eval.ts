/**
 * End-to-end hybrid retrieval benchmark.
 * Covers baseline + adversarial query sets and stage latency capture.
 *
 * @module evals/hybrid.eval
 */

import { evalite } from "evalite";

import { runHybridBenchmark } from "./helpers/hybrid-benchmark";

evalite("Hybrid Retrieval Benchmark", {
  data: async () => [
    {
      input: { run: "hybrid-benchmark" },
      expected: null,
    },
  ],

  task: async () => runHybridBenchmark(),

  scorers: [
    {
      name: "Recall@5",
      description: "Average recall in top 5 across benchmark cases",
      scorer: ({ output }) => ({ score: output.metrics.recallAt5 }),
    },
    {
      name: "Recall@10",
      description: "Average recall in top 10 across benchmark cases",
      scorer: ({ output }) => ({ score: output.metrics.recallAt10 }),
    },
    {
      name: "nDCG@10",
      description: "Average ranking quality with graded relevance",
      scorer: ({ output }) => ({ score: output.metrics.ndcgAt10 }),
    },
    {
      name: "MRR",
      description: "Average reciprocal rank of first relevant result",
      scorer: ({ output }) => ({ score: output.metrics.mrr }),
    },
    {
      name: "Latency P95 < 200ms",
      description: "Soft latency budget for total p95 runtime",
      scorer: ({ output }) => {
        const p95 = output.latencies.total.p95Ms;
        const budget = 200;
        const score =
          p95 <= budget ? 1 : Math.max(0, 1 - (p95 - budget) / (budget * 2));
        return {
          score,
          metadata: { p95Ms: p95, budgetMs: budget },
        };
      },
    },
  ],

  columns: ({ output }) => [
    { label: "Cases", value: output.caseCount.toString() },
    {
      label: "Recall@5",
      value: `${Math.round(output.metrics.recallAt5 * 100)}%`,
    },
    {
      label: "nDCG@10",
      value: `${Math.round(output.metrics.ndcgAt10 * 100)}%`,
    },
    { label: "MRR", value: `${Math.round(output.metrics.mrr * 100)}%` },
    {
      label: "Total p95",
      value: `${output.latencies.total.p95Ms.toFixed(1)}ms`,
    },
    {
      label: "BM25 p95",
      value: `${output.latencies.byStage.bm25.p95Ms.toFixed(1)}ms`,
    },
    {
      label: "Assembly p95",
      value: `${output.latencies.byStage.assembly.p95Ms.toFixed(1)}ms`,
    },
  ],

  trialCount: 1,
});
