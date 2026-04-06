#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  extractFixtureMetrics,
  loadHarnessConfig,
  loadSearchSpace,
} from "../lib/results";

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
const sharedCacheDir = join(outDir, `${candidate.id}.cache`);

runCommand(config.metric.validationCommand);
runCommand(config.metric.smokeCommand);

const startedAt = Date.now();
const benchmarkPaths: Record<string, string> = {};
const benchmarks: Record<string, object> = {};
for (const fixture of [
  config.metric.fixtures.primary,
  config.metric.fixtures.secondary,
].filter(Boolean) as string[]) {
  const benchmarkPath = join(
    outDir,
    `${candidate.id}.${fixture}.benchmark.json`
  );
  benchmarkPaths[fixture] = benchmarkPath;
  runCommand([
    "bun",
    "scripts/code-embedding-benchmark.ts",
    "--model",
    candidate.runtime.uri,
    "--label",
    candidate.label,
    "--fixture",
    fixture,
    "--cache-dir",
    sharedCacheDir,
    "--out",
    benchmarkPath,
  ]);
  benchmarks[fixture] = await Bun.file(benchmarkPath).json();
}

const primary = extractFixtureMetrics(
  { benchmarks } as never,
  config.metric.fixtures.primary
);
const secondary = config.metric.fixtures.secondary
  ? extractFixtureMetrics(
      { benchmarks } as never,
      config.metric.fixtures.secondary
    )
  : {
      vectorNdcgAt10: 0,
      vectorRecallAt5: 0,
      hybridNdcgAt10: 0,
    };
const weightedScore =
  primary.vectorNdcgAt10 * 1000 +
  primary.vectorRecallAt5 * 150 +
  secondary.vectorNdcgAt10 * 700 +
  secondary.hybridNdcgAt10 * 150;

const resultPath = join(outDir, `${candidate.id}.result.json`);
await Bun.write(
  resultPath,
  `${JSON.stringify(
    {
      candidateId: candidate.id,
      label: candidate.label,
      runtime: candidate.runtime,
      benchmarkPaths,
      benchmarks,
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

function runCommand(command: string | string[]): void {
  const proc = Bun.spawnSync({
    cmd: Array.isArray(command) ? command : command.split(" "),
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}
