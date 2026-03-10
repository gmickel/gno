#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CandidateMatrixEntry } from "../../../evals/helpers/retrieval-candidate-matrix";

import { runRetrievalCandidateBenchmark } from "../../../evals/helpers/retrieval-candidate-benchmark";

interface MetricsSnapshot {
  ndcgAt10: number;
  askRecallAt5: number;
  schemaSuccessRate: number;
  p95Ms: number;
}

const [
  leftRun = "auto-entity-lock-default-mix",
  rightRun = "auto-entity-lock-default-mix-lr95",
  repeatRaw = "3",
] = process.argv.slice(2);
const repeat = Number.parseInt(repeatRaw, 10);
if (!Number.isFinite(repeat) || repeat <= 0) {
  throw new Error(`Invalid repeat count: ${repeatRaw}`);
}

const repoRoot = join(import.meta.dir, "../../..");

const leftCandidate = candidateFromRun(leftRun);
const rightCandidate = candidateFromRun(rightRun);

const leftSnapshots: MetricsSnapshot[] = [];
const rightSnapshots: MetricsSnapshot[] = [];

for (let index = 0; index < repeat; index += 1) {
  console.log(`Repeat ${index + 1}/${repeat}: ${leftRun}`);
  leftSnapshots.push(await benchmarkOnce(leftCandidate));
  console.log(`Repeat ${index + 1}/${repeat}: ${rightRun}`);
  rightSnapshots.push(await benchmarkOnce(rightCandidate));
}

const summary = {
  generatedAt: new Date().toISOString(),
  left: {
    run: leftRun,
    repeats: leftSnapshots,
    aggregate: aggregate(leftSnapshots),
  },
  right: {
    run: rightRun,
    repeats: rightSnapshots,
    aggregate: aggregate(rightSnapshots),
  },
};

const outDir = join(repoRoot, "research/finetune/outputs", rightRun);
await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `repeat-benchmark-vs-${leftRun}-x${repeat}.json`);
await Bun.write(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ outPath, summary }, null, 2));

function candidateFromRun(runName: string): CandidateMatrixEntry {
  const ggufPath = join(
    repoRoot,
    `research/finetune/outputs/${runName}-best-fused-deq/gno-expansion-${runName}-f16.gguf`
  );

  return {
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
    notes: `Repeated benchmark candidate from ${runName}`,
  };
}

async function benchmarkOnce(
  candidate: CandidateMatrixEntry
): Promise<MetricsSnapshot> {
  const summary = await runRetrievalCandidateBenchmark(undefined, [candidate]);
  const result = summary.candidates[0];
  if (!result?.ok) {
    throw new Error(result?.error ?? `Benchmark failed for ${candidate.id}`);
  }

  return {
    ndcgAt10: result.retrieval.metrics.ndcgAt10,
    askRecallAt5: result.retrieval.bySet.ask?.metric.recallAt5 ?? 0,
    schemaSuccessRate: result.expansion.schemaSuccessRate,
    p95Ms: result.retrieval.latencies.total.p95Ms,
  };
}

function aggregate(values: MetricsSnapshot[]) {
  return {
    median: {
      ndcgAt10: median(values.map((item) => item.ndcgAt10)),
      askRecallAt5: median(values.map((item) => item.askRecallAt5)),
      schemaSuccessRate: median(values.map((item) => item.schemaSuccessRate)),
      p95Ms: median(values.map((item) => item.p95Ms)),
    },
    mean: {
      ndcgAt10: mean(values.map((item) => item.ndcgAt10)),
      askRecallAt5: mean(values.map((item) => item.askRecallAt5)),
      schemaSuccessRate: mean(values.map((item) => item.schemaSuccessRate)),
      p95Ms: mean(values.map((item) => item.p95Ms)),
    },
  };
}

function mean(values: number[]): number {
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return Number(sorted[middle]!.toFixed(4));
  }
  return Number(
    (((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2).toFixed(4)
  );
}
