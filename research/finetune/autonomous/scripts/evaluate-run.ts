#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";

interface HarnessConfig {
  id: string;
  allowedRoots: string[];
  mutationTargets: string[];
  budget: {
    maxRuntimeMinutes: number;
    maxChangedFiles: number;
  };
  metric: {
    baselineArtifact: string;
    validationCommand: string;
    smokeCommand: string;
    promotionSplit: string;
  };
  logging: {
    runDir: string;
  };
  promotion: {
    humanApprovalRequired: boolean;
  };
}

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
const configPath = join(repoRoot, "research/finetune/autonomous/config.json");
const config = (await Bun.file(configPath).json()) as HarnessConfig;
const runName = process.argv[2] ?? "mlx-run1";
const targets = process.argv.slice(3);

function assertAllowed(paths: string[], allowedRoots: string[]): void {
  for (const path of paths) {
    if (!allowedRoots.some((root) => path.startsWith(root))) {
      throw new Error(`Target outside mutation scope: ${path}`);
    }
  }
}

function run(command: string[]): void {
  const [bin, ...args] = command;
  const result = spawnSync(bin!, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const selectedTargets = targets.length ? targets : config.mutationTargets;
assertAllowed(selectedTargets, config.allowedRoots);

const startedAt = performance.now();
run(["bun", "run", "research:finetune:promote", runName]);

const benchmarkPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}/benchmark-summary.json`
);
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

const decision =
  ndcgDelta >= 0 && schemaDelta >= 0 && p95Delta <= 0 ? "keep" : "discard";

const runArtifact = {
  experimentId: `policy-${runName}`,
  policyId: config.id,
  runName,
  targets: selectedTargets,
  metricCommand: "bun run research:finetune:promote <run>",
  deltas: {
    ndcgAt10: Number(ndcgDelta.toFixed(4)),
    schemaSuccessRate: Number(schemaDelta.toFixed(4)),
    p95Ms: Number(p95Delta.toFixed(2)),
  },
  decision,
  humanApprovalRequired: config.promotion.humanApprovalRequired,
  runtimeSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
};

const outPath = join(repoRoot, config.logging.runDir, `policy-${runName}.json`);
await Bun.write(outPath, `${JSON.stringify(runArtifact, null, 2)}\n`);

console.log(outPath);
