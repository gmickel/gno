#!/usr/bin/env bun
import { join } from "node:path";

interface PromotionTargets {
  retrieval: {
    minimumMedianNdcgAt10: number;
    minimumDeltaVsShippedSlim: number;
    minimumDeltaVsIncumbent: number;
  };
  structure: {
    minimumMedianSchemaSuccessRate: number;
  };
  ask: {
    minimumMedianRecallAt5: number;
    required: boolean;
  };
  latency: {
    maximumMedianP95Ms: number;
  };
}

interface RepeatBody {
  left: {
    run: string;
    aggregate: {
      median: {
        ndcgAt10: number;
        askRecallAt5: number;
        schemaSuccessRate: number;
        p95Ms: number;
      };
    };
  };
  right: {
    run: string;
    aggregate: {
      median: {
        ndcgAt10: number;
        askRecallAt5: number;
        schemaSuccessRate: number;
        p95Ms: number;
      };
    };
  };
}

const [
  incumbentRun = "auto-entity-lock-default-mix",
  challengerRun = "auto-entity-lock-default-mix-lr95",
] = process.argv.slice(2);
const repoRoot = join(import.meta.dir, "../../../..");

const targets = (await Bun.file(
  join(repoRoot, "research/finetune/configs/promotion-targets.json")
).json()) as PromotionTargets;
const rawRepeat = (await Bun.file(
  join(
    repoRoot,
    `research/finetune/outputs/${challengerRun}/repeat-benchmark-vs-${incumbentRun}-x3.json`
  )
).json()) as RepeatBody | { summary: RepeatBody };
const repeat = "summary" in rawRepeat ? rawRepeat.summary : rawRepeat;
const baseline = (await Bun.file(
  join(repoRoot, "evals/fixtures/retrieval-candidate-benchmark/latest.json")
).json()) as {
  candidates: Array<{
    candidate?: { id?: string };
    retrieval: { metrics: { ndcgAt10: number } };
  }>;
};

const shippedSlim = baseline.candidates.find(
  (candidate) => candidate.candidate?.id === "current-qwen3-1.7b-q4"
);
if (!shippedSlim) {
  throw new Error("Missing shipped slim baseline");
}

const incumbent =
  repeat.left.run === incumbentRun
    ? repeat.left.aggregate.median
    : repeat.right.aggregate.median;
const challenger =
  repeat.right.run === challengerRun
    ? repeat.right.aggregate.median
    : repeat.left.aggregate.median;

const checks = {
  medianNdcg: challenger.ndcgAt10 >= targets.retrieval.minimumMedianNdcgAt10,
  deltaVsShipped:
    challenger.ndcgAt10 - shippedSlim.retrieval.metrics.ndcgAt10 >=
    targets.retrieval.minimumDeltaVsShippedSlim,
  deltaVsIncumbent:
    challenger.ndcgAt10 - incumbent.ndcgAt10 >=
    targets.retrieval.minimumDeltaVsIncumbent,
  schema:
    challenger.schemaSuccessRate >=
    targets.structure.minimumMedianSchemaSuccessRate,
  ask:
    !targets.ask.required ||
    challenger.askRecallAt5 >= targets.ask.minimumMedianRecallAt5,
  latency: challenger.p95Ms <= targets.latency.maximumMedianP95Ms,
};

const passed = Object.values(checks).every(Boolean);
const artifact = {
  generatedAt: new Date().toISOString(),
  incumbentRun,
  challengerRun,
  passed,
  checks,
  challengerMedian: challenger,
  incumbentMedian: incumbent,
  shippedSlimNdcgAt10: shippedSlim.retrieval.metrics.ndcgAt10,
};

const outPath = join(
  repoRoot,
  "research/finetune/autonomous/runs",
  `promotion-target-check-${challengerRun}.json`
);
await Bun.write(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(outPath);
