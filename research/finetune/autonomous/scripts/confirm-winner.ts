#!/usr/bin/env bun
import { join } from "node:path";

import type { ConfirmedIncumbentArtifact } from "../lib/results";

interface RepeatAggregate {
  median: {
    ndcgAt10: number;
    askRecallAt5: number;
    schemaSuccessRate: number;
    p95Ms: number;
  };
}

interface RepeatSummary {
  generatedAt: string;
  left: { run: string; aggregate: RepeatAggregate };
  right: { run: string; aggregate: RepeatAggregate };
}

const [
  incumbentRun = "auto-entity-lock-default-mix",
  challengerRun = "auto-entity-lock-default-mix-lr95",
] = process.argv.slice(2);
const repoRoot = join(import.meta.dir, "../../../..");
const repeatPath = join(
  repoRoot,
  `research/finetune/outputs/${challengerRun}/repeat-benchmark-vs-${incumbentRun}-x3.json`
);

const raw = (await Bun.file(repeatPath).json()) as
  | RepeatSummary
  | { summary: RepeatSummary };
const repeat = "summary" in raw ? raw.summary : raw;
const incumbent = repeat.left.run === incumbentRun ? repeat.left : repeat.right;
const challenger =
  repeat.right.run === challengerRun ? repeat.right : repeat.left;

const decision =
  challenger.aggregate.median.ndcgAt10 > incumbent.aggregate.median.ndcgAt10
    ? "promote-challenger"
    : "keep-incumbent";

const rationale =
  decision === "promote-challenger"
    ? `median nDCG improved from ${incumbent.aggregate.median.ndcgAt10.toFixed(4)} to ${challenger.aggregate.median.ndcgAt10.toFixed(4)}`
    : `challenger median nDCG ${challenger.aggregate.median.ndcgAt10.toFixed(4)} did not beat incumbent ${incumbent.aggregate.median.ndcgAt10.toFixed(4)}`;

const artifact: ConfirmedIncumbentArtifact = {
  generatedAt: new Date().toISOString(),
  incumbentRun,
  challengerRun,
  repeatPath,
  decision,
  rationale,
  incumbentMedian: incumbent.aggregate.median,
  challengerMedian: challenger.aggregate.median,
};

const outPath = join(
  repoRoot,
  "research/finetune/autonomous/runs/confirmed-incumbent.json"
);
await Bun.write(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(outPath);
