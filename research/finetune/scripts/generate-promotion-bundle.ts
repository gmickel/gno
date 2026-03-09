#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const runName = process.argv[2] ?? "mlx-run1";
const repoRoot = join(import.meta.dir, "../../..");
const runDir = join(repoRoot, "research/finetune/outputs", runName);
const bestPath = join(runDir, "best-checkpoint.json");
const benchmarkPath = join(runDir, "benchmark-summary.json");
const ggufPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}-best-fused-deq/gno-expansion-${runName}-f16.gguf`
);
const baselinePath = join(
  repoRoot,
  "evals/fixtures/retrieval-candidate-benchmark/latest.json"
);

const [best, benchmark, baseline] = await Promise.all([
  Bun.file(bestPath).json(),
  Bun.file(benchmarkPath).json(),
  Bun.file(baselinePath).json(),
]);

const candidate = (benchmark as { candidates: Array<Record<string, unknown>> })
  .candidates[0] as {
  retrieval: {
    metrics: { ndcgAt10: number };
    bySet?: { ask?: { metric: { recallAt5: number } } };
    latencies: { total: { p95Ms: number } };
  };
  expansion: { schemaSuccessRate: number };
};

const baselineCandidate = (
  baseline as { candidates: Array<Record<string, unknown>> }
).candidates.find(
  (item) =>
    (item as { candidate?: { id?: string } }).candidate?.id ===
    "current-qwen3-1.7b-q4"
) as {
  retrieval: {
    metrics: { ndcgAt10: number };
    bySet?: { ask?: { metric: { recallAt5: number } } };
    latencies: { total: { p95Ms: number } };
  };
  expansion: { schemaSuccessRate: number };
};

const promotedDir = join(runDir, "promotion");
await mkdir(promotedDir, { recursive: true });

const summary = {
  runName,
  bestCheckpoint: best,
  artifact: {
    ggufPath,
    fileUri: `file:${ggufPath}`,
  },
  benchmark: {
    ndcgAt10: candidate.retrieval.metrics.ndcgAt10,
    askRecallAt5: candidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0,
    schemaSuccessRate: candidate.expansion.schemaSuccessRate,
    p95Ms: candidate.retrieval.latencies.total.p95Ms,
  },
  baseline: {
    ndcgAt10: baselineCandidate.retrieval.metrics.ndcgAt10,
    askRecallAt5: baselineCandidate.retrieval.bySet?.ask?.metric.recallAt5 ?? 0,
    schemaSuccessRate: baselineCandidate.expansion.schemaSuccessRate,
    p95Ms: baselineCandidate.retrieval.latencies.total.p95Ms,
  },
};

await Bun.write(
  join(promotedDir, "promotion-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);

const installSnippet = `models:
  activePreset: tuned
  presets:
    - id: tuned
      name: Fine-tuned Expansion (${runName})
      embed: "hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf"
      rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"
      gen: "file:${ggufPath}"
`;

await Bun.write(join(promotedDir, "install-snippet.yaml"), installSnippet);

const modelCard = `# ${runName}

Base model: \`Qwen3-1.7B\`
Best checkpoint: \`${basename((best as { best: { adapterFile: string } }).best.adapterFile)}\`
Exported artifact: \`${ggufPath}\`

## Benchmark

- Fine-tuned \`nDCG@10\`: ${summary.benchmark.ndcgAt10.toFixed(4)}
- Baseline \`nDCG@10\`: ${summary.baseline.ndcgAt10.toFixed(4)}
- Fine-tuned ask \`Recall@5\`: ${summary.benchmark.askRecallAt5.toFixed(4)}
- Baseline ask \`Recall@5\`: ${summary.baseline.askRecallAt5.toFixed(4)}
- Fine-tuned schema success: ${(summary.benchmark.schemaSuccessRate * 100).toFixed(1)}%
- Baseline schema success: ${(summary.baseline.schemaSuccessRate * 100).toFixed(1)}%
- Fine-tuned p95: ${summary.benchmark.p95Ms.toFixed(1)}ms
- Baseline p95: ${summary.baseline.p95Ms.toFixed(1)}ms

## Install In GNO

\`\`\`yaml
${installSnippet.trim()}
\`\`\`
`;

await Bun.write(join(promotedDir, "MODEL_CARD.md"), modelCard);

console.log(join(promotedDir, "promotion-summary.json"));
