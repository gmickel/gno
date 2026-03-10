#!/usr/bin/env bun
import { join } from "node:path";

const [leftRun = "mlx-run1", rightRun = "mlx-run2"] = process.argv.slice(2);
const repoRoot = join(import.meta.dir, "../../..");

function loadRun(runName: string) {
  const summaryPath = join(
    repoRoot,
    `research/finetune/outputs/${runName}/benchmark-summary.json`
  );
  return Bun.file(summaryPath).json();
}

const [left, right] = await Promise.all([loadRun(leftRun), loadRun(rightRun)]);
const leftCandidate = (left as { candidates: Array<Record<string, unknown>> })
  .candidates[0] as {
  retrieval: {
    metrics: { ndcgAt10: number };
    bySet?: { ask?: { metric: { recallAt5: number } } };
    latencies: { total: { p95Ms: number } };
  };
  expansion: { schemaSuccessRate: number };
};
const rightCandidate = (right as { candidates: Array<Record<string, unknown>> })
  .candidates[0] as {
  retrieval: {
    metrics: { ndcgAt10: number };
    bySet?: { ask?: { metric: { recallAt5: number } } };
    latencies: { total: { p95Ms: number } };
  };
  expansion: { schemaSuccessRate: number };
};

const comparison = {
  left: {
    run: leftRun,
    ndcgAt10: leftCandidate.retrieval.metrics.ndcgAt10,
    askRecallAt5: leftCandidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0,
    schemaSuccessRate: leftCandidate.expansion.schemaSuccessRate,
    p95Ms: leftCandidate.retrieval.latencies.total.p95Ms,
  },
  right: {
    run: rightRun,
    ndcgAt10: rightCandidate.retrieval.metrics.ndcgAt10,
    askRecallAt5: rightCandidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0,
    schemaSuccessRate: rightCandidate.expansion.schemaSuccessRate,
    p95Ms: rightCandidate.retrieval.latencies.total.p95Ms,
  },
  deltas: {
    ndcgAt10: Number(
      (
        rightCandidate.retrieval.metrics.ndcgAt10 -
        leftCandidate.retrieval.metrics.ndcgAt10
      ).toFixed(4)
    ),
    askRecallAt5: Number(
      (
        (rightCandidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0) -
        (leftCandidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0)
      ).toFixed(4)
    ),
    schemaSuccessRate: Number(
      (
        rightCandidate.expansion.schemaSuccessRate -
        leftCandidate.expansion.schemaSuccessRate
      ).toFixed(4)
    ),
    p95Ms: Number(
      (
        rightCandidate.retrieval.latencies.total.p95Ms -
        leftCandidate.retrieval.latencies.total.p95Ms
      ).toFixed(2)
    ),
  },
};

const outPath = join(
  repoRoot,
  `research/finetune/outputs/${rightRun}/comparison-vs-${leftRun}.json`
);
await Bun.write(outPath, `${JSON.stringify(comparison, null, 2)}\n`);
console.log(outPath);
