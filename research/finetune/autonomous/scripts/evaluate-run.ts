#!/usr/bin/env bun
import { join } from "node:path";

import { loadHarnessConfig } from "../lib/results";

interface BenchmarkSummary {
  candidates: Array<{
    retrieval: {
      metrics: { ndcgAt10: number };
      bySet?: { ask?: { metric: { recallAt5: number } } };
      latencies: { total: { p95Ms: number } };
    };
    expansion: { schemaSuccessRate: number };
  }>;
}

const repoRoot = join(import.meta.dir, "../../../..");
const config = await loadHarnessConfig(repoRoot);
const args = process.argv.slice(2);
const forcePromote = args.includes("--force-promote");
const positionalArgs = args.filter((arg) => arg !== "--force-promote");
const runName = positionalArgs[0] ?? "mlx-run1";
const targets = positionalArgs.slice(1);

function assertAllowed(paths: string[], allowedRoots: string[]): void {
  for (const path of paths) {
    if (!allowedRoots.some((root) => path.startsWith(root))) {
      throw new Error(`Target outside mutation scope: ${path}`);
    }
  }
}

function run(command: string[]): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

const selectedTargets = targets.length ? targets : config.mutationTargets;
assertAllowed(selectedTargets, config.allowedRoots);

const startedAt = performance.now();
const benchmarkPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}/benchmark-summary.json`
);
const benchmarkExists = await Bun.file(benchmarkPath).exists();
const ranPromotion = forcePromote || !benchmarkExists;
if (ranPromotion) {
  run(["bun", "run", "research:finetune:promote", runName]);
} else {
  console.log(`Reusing existing benchmark summary for ${runName}`);
}

const baselinePath = join(repoRoot, config.metric.baselineArtifact);
const [benchmark, baseline] = await Promise.all([
  Bun.file(benchmarkPath).json(),
  Bun.file(baselinePath).json(),
]);

const benchmarkCandidate = (benchmark as BenchmarkSummary).candidates[0];
const baselineCandidate = (
  baseline as { candidates: Array<Record<string, unknown>> }
).candidates.find(
  (item) =>
    (item as { candidate?: { id?: string } }).candidate?.id ===
    "current-qwen3-1.7b-q4"
) as BenchmarkSummary["candidates"][number];

if (!benchmarkCandidate) {
  throw new Error(`No benchmark candidate found in ${benchmarkPath}`);
}
if (!baselineCandidate) {
  throw new Error(`No shipped baseline candidate found in ${baselinePath}`);
}

const ndcgDelta =
  benchmarkCandidate.retrieval.metrics.ndcgAt10 -
  baselineCandidate.retrieval.metrics.ndcgAt10;
const schemaDelta =
  benchmarkCandidate.expansion.schemaSuccessRate -
  baselineCandidate.expansion.schemaSuccessRate;
const p95Delta =
  benchmarkCandidate.retrieval.latencies.total.p95Ms -
  baselineCandidate.retrieval.latencies.total.p95Ms;
const askDelta =
  (benchmarkCandidate.retrieval.bySet?.ask?.metric?.recallAt5 ?? 0) -
  (baselineCandidate.retrieval.bySet?.ask?.metric?.recallAt5 ?? 0);

const weightedScore =
  ndcgDelta * config.metric.decision.weights.ndcgAt10 +
  schemaDelta * config.metric.decision.weights.schemaSuccessRate +
  askDelta * config.metric.decision.weights.askRecallAt5 +
  p95Delta * config.metric.decision.weights.p95Ms;

const decision =
  ndcgDelta >= config.metric.decision.minimums.ndcgDelta &&
  schemaDelta >= config.metric.decision.minimums.schemaDelta &&
  weightedScore > 0
    ? "keep"
    : "discard";

const runArtifact = {
  experimentId: `policy-${runName}`,
  policyId: config.id,
  runName,
  targets: selectedTargets,
  metricCommand: ranPromotion
    ? "bun run research:finetune:promote <run>"
    : "reuse benchmark-summary.json",
  deltas: {
    ndcgAt10: Number(ndcgDelta.toFixed(4)),
    schemaSuccessRate: Number(schemaDelta.toFixed(4)),
    askRecallAt5: Number(askDelta.toFixed(4)),
    p95Ms: Number(p95Delta.toFixed(2)),
    weightedScore: Number(weightedScore.toFixed(2)),
  },
  decision,
  humanApprovalRequired: config.promotion.humanApprovalRequired,
  runtimeSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
};

const outPath = join(repoRoot, config.logging.runDir, `policy-${runName}.json`);
await Bun.write(outPath, `${JSON.stringify(runArtifact, null, 2)}\n`);

console.log(outPath);
