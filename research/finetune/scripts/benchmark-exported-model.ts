#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CandidateMatrixEntry } from "../../../evals/helpers/retrieval-candidate-matrix";

import { runRetrievalCandidateBenchmark } from "../../../evals/helpers/retrieval-candidate-benchmark";

const runName = process.argv[2] ?? "mlx-run1";
const repoRoot = join(import.meta.dir, "../../..");
const ggufPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}-best-fused-deq/gno-expansion-${runName}-f16.gguf`
);

const candidate: CandidateMatrixEntry = {
  id: `sandbox-${runName}`,
  label: `Sandbox ${runName}`,
  family: "Qwen3-1.7B fine-tuned",
  uri: `file:${ggufPath}`,
  quantization: "F16",
  sourceModelUrl: "mlx-community/Qwen3-1.7B-4bit",
  ggufUrl: ggufPath,
  roleTests: ["expand", "answer"],
  expectedRamGiB: 4,
  expectedVramGiB: 0,
  notes: `Auto-benchmarked exported candidate from ${runName}`,
};

const summary = await runRetrievalCandidateBenchmark(undefined, [candidate]);
const outDir = join(repoRoot, "research/finetune/outputs", runName);
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, "benchmark-summary.json");
await Bun.write(outPath, `${JSON.stringify(summary, null, 2)}\n`);

const result = summary.candidates[0];
if (!result?.ok) {
  throw new Error(result?.error ?? "benchmark failed");
}

console.log(
  JSON.stringify(
    {
      runName,
      ggufPath,
      benchmarkPath: outPath,
      ndcgAt10: result.retrieval.metrics.ndcgAt10,
      askRecallAt5: result.retrieval.bySet.ask?.metric.recallAt5 ?? 0,
      schemaSuccessRate: result.expansion.schemaSuccessRate,
      p95Ms: result.retrieval.latencies.total.p95Ms,
    },
    null,
    2
  )
);
