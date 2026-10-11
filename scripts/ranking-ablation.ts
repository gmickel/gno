#!/usr/bin/env bun
/**
 * Hybrid ranking ablation (opt-in; not part of `bun test`).
 *
 * Runs the judged retrieval benchmark cases through the full hybrid pipeline
 * (BM25, vectors, query expansion and reranking with the default preset's
 * real models) once per ranking variant, and prints the metrics side by side.
 * The first pass also warms the expansion cache, so every variant ranks the
 * same expansions. Usage: `bun run eval:ranking-ablation`.
 */

import type { PipelineConfig } from "../src/pipeline/types";

import {
  type BenchmarkRuntime,
  benchmarkRetrieval,
  ensureVectorIndex,
} from "../evals/helpers/retrieval-candidate-benchmark";
import { getSharedEvalDb } from "../evals/helpers/setup-db";
import { createDefaultConfig } from "../src/config";
import { DEFAULT_MODEL_PRESETS } from "../src/config/types";
import { LlmAdapter } from "../src/llm/nodeLlamaCpp/adapter";
import { DEFAULT_PIPELINE_CONFIG } from "../src/pipeline/types";

const linear = (fusionWeight: number): PipelineConfig => ({
  ...DEFAULT_PIPELINE_CONFIG,
  blendingSchedule: [
    {
      maxRank: Number.POSITIVE_INFINITY,
      fusionWeight,
      rerankWeight: 1 - fusionWeight,
    },
  ],
});

const VARIANTS: [label: string, config: PipelineConfig][] = [
  ["baseline (tiered blend)", DEFAULT_PIPELINE_CONFIG],
  ["monotonic blend 0.5/0.5", linear(0.5)],
  ["monotonic blend 0.3/0.7", linear(0.3)],
  ["rerank first, fusion tie-break", linear(0.001)],
];

const config = createDefaultConfig();
const llm = new LlmAdapter(config);
const ctx = await getSharedEvalDb();
const runtimeBase = { config, llm, store: ctx.adapter };
const runtime: BenchmarkRuntime = {
  ...runtimeBase,
  ...(await ensureVectorIndex(runtimeBase)),
};
if (!runtime.vectorAvailable)
  throw new Error(
    "Vector search unavailable (sqlite-vec); a lexical-only run is not a hybrid comparison"
  );
const expandUri = DEFAULT_MODEL_PRESETS[0]?.expand;
if (!expandUri) throw new Error("Default expansion model missing");
const genResult = await llm.createGenerationPort(expandUri, {
  policy: { offline: false, allowDownload: true },
  egressCollections: "all",
});
if (!genResult.ok) throw new Error(genResult.error.message);

// Warm-up pass: fills the expansion cache so variants differ only in ranking.
await benchmarkRetrieval(runtime, genResult.value);

const fmt = (value: number | undefined) => (value ?? 0).toFixed(3);
console.log(
  `| Variant | nDCG@10 | MRR | R@5 | R@10 | baseline nDCG | adversarial nDCG | multilingual nDCG | ask R@5 |`
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
let caseCount = 0;
const perVariant: [string, Awaited<ReturnType<typeof benchmarkRetrieval>>][] =
  [];
for (const [label, pipelineConfig] of VARIANTS) {
  const result = await benchmarkRetrieval(
    runtime,
    genResult.value,
    pipelineConfig
  );
  const { metrics, bySet } = result;
  caseCount = result.caseCount;
  perVariant.push([label, result]);
  console.log(
    `| ${label} | ${fmt(metrics.ndcgAt10)} | ${fmt(metrics.mrr)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} | ${fmt(bySet.baseline?.metric.ndcgAt10)} | ${fmt(bySet.adversarial?.metric.ndcgAt10)} | ${fmt(bySet.multilingual?.metric.ndcgAt10)} | ${fmt(bySet.ask?.metric.recallAt5)} |`
  );
}
console.log(`\ncases=${caseCount} (default preset, real models)`);

// --cases: every case whose nDCG@10 differs from the baseline, with top docs.
if (process.argv.includes("--cases")) {
  const [, baseline] = perVariant[0]!;
  const byId = new Map(baseline.cases.map((item) => [item.id, item]));
  for (const [label, result] of perVariant.slice(1)) {
    console.log(`\n## ${label}`);
    for (const item of result.cases) {
      const before = byId.get(item.id);
      if (!before || Math.abs(before.ndcgAt10 - item.ndcgAt10) < 1e-6) continue;
      console.log(
        `- ${item.id} (${item.caseSet}) "${item.query}": nDCG ${before.ndcgAt10.toFixed(3)} -> ${item.ndcgAt10.toFixed(3)}; top ${before.topDocs.slice(0, 3).join(", ")} -> ${item.topDocs.slice(0, 3).join(", ")}`
      );
    }
  }
}
