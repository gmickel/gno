#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadHarnessConfig, loadSearchSpace } from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
const candidateId = process.argv[2];
if (!candidateId) {
  throw new Error(
    "Usage: bun run research:embeddings:autonomous:run-candidate <candidate-id>"
  );
}

const [config, searchSpace] = await Promise.all([
  loadHarnessConfig(repoRoot),
  loadSearchSpace(repoRoot),
]);
const candidate = searchSpace.candidates.find(
  (item) => item.id === candidateId
);
if (!candidate) {
  throw new Error(`Unknown candidate: ${candidateId}`);
}

const outDir = join(repoRoot, config.logging.runDir);
await mkdir(outDir, { recursive: true });
const benchmarkPath = join(outDir, `${candidate.id}.benchmark.json`);

runCommand(config.metric.validationCommand);
runCommand(config.metric.smokeCommand);

const startedAt = Date.now();
runCommand(
  `bun scripts/code-embedding-benchmark.ts --candidate ${candidate.id} --out ${benchmarkPath}`
);

const benchmark = (await Bun.file(benchmarkPath).json()) as {
  vector?: {
    metrics?: { ndcgAt10?: number; recallAt5?: number };
    latency?: { p95Ms?: number };
  };
  hybrid?: { metrics?: { ndcgAt10?: number }; latency?: { p95Ms?: number } };
};
const weightedScore =
  (benchmark.vector?.metrics?.ndcgAt10 ?? 0) * 1000 +
  (benchmark.vector?.metrics?.recallAt5 ?? 0) * 150 +
  (benchmark.hybrid?.metrics?.ndcgAt10 ?? 0) * 250 -
  (benchmark.vector?.latency?.p95Ms ?? 0) * 0.02 -
  (benchmark.hybrid?.latency?.p95Ms ?? 0) * 0.01;

const resultPath = join(outDir, `${candidate.id}.result.json`);
await Bun.write(
  resultPath,
  `${JSON.stringify(
    {
      candidateId: candidate.id,
      label: candidate.label,
      embedModel: candidate.embedModel,
      benchmarkPath,
      benchmark,
      decision:
        candidate.id === searchSpace.incumbentId ? "baseline" : "pending",
      weightedScore: Number(weightedScore.toFixed(4)),
      runtimeSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  )}\n`
);

console.log(resultPath);

function runCommand(command: string): void {
  const proc = Bun.spawnSync({
    cmd: command.split(" "),
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}
