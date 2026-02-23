#!/usr/bin/env bun
/**
 * Run hybrid benchmark and optionally persist baseline artifacts.
 * Usage:
 *   bun scripts/hybrid-benchmark.ts
 *   bun scripts/hybrid-benchmark.ts --write
 *   bun scripts/hybrid-benchmark.ts --delta
 *   bun scripts/hybrid-benchmark.ts --delta --baseline /path/to/baseline.json
 *
 * @module scripts/hybrid-benchmark
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  type HybridBenchmarkSummary,
  runHybridBenchmark,
} from "../evals/helpers/hybrid-benchmark";

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function toMarkdown(
  summary: Awaited<ReturnType<typeof runHybridBenchmark>>
): string {
  return `# Hybrid Baseline Snapshot

Generated: ${summary.generatedAt}
Cases: ${summary.caseCount}
Corpus docs: ${summary.corpusDocs}

## Retrieval Metrics

| Metric | Value |
| --- | --- |
| Recall@5 | ${formatPercent(summary.metrics.recallAt5)} |
| Recall@10 | ${formatPercent(summary.metrics.recallAt10)} |
| nDCG@10 | ${formatPercent(summary.metrics.ndcgAt10)} |
| MRR | ${formatPercent(summary.metrics.mrr)} |

## Latency (ms)

| Stage | p50 | p95 | mean |
| --- | ---: | ---: | ---: |
| total | ${summary.latencies.total.p50Ms.toFixed(2)} | ${summary.latencies.total.p95Ms.toFixed(2)} | ${summary.latencies.total.meanMs.toFixed(2)} |
| lang | ${summary.latencies.byStage.lang.p50Ms.toFixed(2)} | ${summary.latencies.byStage.lang.p95Ms.toFixed(2)} | ${summary.latencies.byStage.lang.meanMs.toFixed(2)} |
| expansion | ${summary.latencies.byStage.expansion.p50Ms.toFixed(2)} | ${summary.latencies.byStage.expansion.p95Ms.toFixed(2)} | ${summary.latencies.byStage.expansion.meanMs.toFixed(2)} |
| bm25 | ${summary.latencies.byStage.bm25.p50Ms.toFixed(2)} | ${summary.latencies.byStage.bm25.p95Ms.toFixed(2)} | ${summary.latencies.byStage.bm25.meanMs.toFixed(2)} |
| vector | ${summary.latencies.byStage.vector.p50Ms.toFixed(2)} | ${summary.latencies.byStage.vector.p95Ms.toFixed(2)} | ${summary.latencies.byStage.vector.meanMs.toFixed(2)} |
| fusion | ${summary.latencies.byStage.fusion.p50Ms.toFixed(2)} | ${summary.latencies.byStage.fusion.p95Ms.toFixed(2)} | ${summary.latencies.byStage.fusion.meanMs.toFixed(2)} |
| rerank | ${summary.latencies.byStage.rerank.p50Ms.toFixed(2)} | ${summary.latencies.byStage.rerank.p95Ms.toFixed(2)} | ${summary.latencies.byStage.rerank.meanMs.toFixed(2)} |
| assembly | ${summary.latencies.byStage.assembly.p50Ms.toFixed(2)} | ${summary.latencies.byStage.assembly.p95Ms.toFixed(2)} | ${summary.latencies.byStage.assembly.meanMs.toFixed(2)} |
`;
}

function formatDelta(
  current: number,
  baseline: number,
  precision = 2,
  suffix = ""
): string {
  const delta = current - baseline;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(precision)}${suffix}`;
}

function toDeltaMarkdown(
  baselinePath: string,
  baseline: HybridBenchmarkSummary,
  current: HybridBenchmarkSummary
): string {
  return `# Hybrid Benchmark Delta

Baseline: ${baselinePath}
Generated: ${current.generatedAt}

## Quality Delta

| Metric | Baseline | Current | Delta |
| --- | ---: | ---: | ---: |
| Recall@5 | ${formatPercent(baseline.metrics.recallAt5)} | ${formatPercent(current.metrics.recallAt5)} | ${formatDelta(current.metrics.recallAt5 * 100, baseline.metrics.recallAt5 * 100, 2, "%")} |
| Recall@10 | ${formatPercent(baseline.metrics.recallAt10)} | ${formatPercent(current.metrics.recallAt10)} | ${formatDelta(current.metrics.recallAt10 * 100, baseline.metrics.recallAt10 * 100, 2, "%")} |
| nDCG@10 | ${formatPercent(baseline.metrics.ndcgAt10)} | ${formatPercent(current.metrics.ndcgAt10)} | ${formatDelta(current.metrics.ndcgAt10 * 100, baseline.metrics.ndcgAt10 * 100, 2, "%")} |
| MRR | ${formatPercent(baseline.metrics.mrr)} | ${formatPercent(current.metrics.mrr)} | ${formatDelta(current.metrics.mrr * 100, baseline.metrics.mrr * 100, 2, "%")} |

## Latency Delta (ms)

| Stage | Baseline p95 | Current p95 | Delta |
| --- | ---: | ---: | ---: |
| total | ${baseline.latencies.total.p95Ms.toFixed(2)} | ${current.latencies.total.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.total.p95Ms, baseline.latencies.total.p95Ms, 2, "ms")} |
| bm25 | ${baseline.latencies.byStage.bm25.p95Ms.toFixed(2)} | ${current.latencies.byStage.bm25.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.byStage.bm25.p95Ms, baseline.latencies.byStage.bm25.p95Ms, 2, "ms")} |
| vector | ${baseline.latencies.byStage.vector.p95Ms.toFixed(2)} | ${current.latencies.byStage.vector.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.byStage.vector.p95Ms, baseline.latencies.byStage.vector.p95Ms, 2, "ms")} |
| fusion | ${baseline.latencies.byStage.fusion.p95Ms.toFixed(2)} | ${current.latencies.byStage.fusion.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.byStage.fusion.p95Ms, baseline.latencies.byStage.fusion.p95Ms, 2, "ms")} |
| rerank | ${baseline.latencies.byStage.rerank.p95Ms.toFixed(2)} | ${current.latencies.byStage.rerank.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.byStage.rerank.p95Ms, baseline.latencies.byStage.rerank.p95Ms, 2, "ms")} |
| assembly | ${baseline.latencies.byStage.assembly.p95Ms.toFixed(2)} | ${current.latencies.byStage.assembly.p95Ms.toFixed(2)} | ${formatDelta(current.latencies.byStage.assembly.p95Ms, baseline.latencies.byStage.assembly.p95Ms, 2, "ms")} |
`;
}

async function loadBaseline(
  baselinePath: string
): Promise<HybridBenchmarkSummary | null> {
  const file = Bun.file(baselinePath);
  if (!(await file.exists())) {
    return null;
  }
  return (await file.json()) as HybridBenchmarkSummary;
}

const args = new Set(process.argv.slice(2));
const baselineArgIndex = process.argv.indexOf("--baseline");
const baselinePath =
  baselineArgIndex > -1
    ? (process.argv[baselineArgIndex + 1] ??
      join(import.meta.dir, "../evals/fixtures/hybrid-baseline/latest.json"))
    : join(import.meta.dir, "../evals/fixtures/hybrid-baseline/latest.json");
const summary = await runHybridBenchmark();
const baseline = args.has("--delta") ? await loadBaseline(baselinePath) : null;

console.log(`Hybrid benchmark: ${summary.caseCount} cases`);
console.log(
  `Quality: R@5 ${formatPercent(summary.metrics.recallAt5)}, R@10 ${formatPercent(summary.metrics.recallAt10)}, nDCG@10 ${formatPercent(summary.metrics.ndcgAt10)}, MRR ${formatPercent(summary.metrics.mrr)}`
);
console.log(
  `Latency: total p50=${summary.latencies.total.p50Ms.toFixed(2)}ms p95=${summary.latencies.total.p95Ms.toFixed(2)}ms`
);

if (args.has("--delta")) {
  if (!baseline) {
    console.log(`No baseline found at ${baselinePath}`);
  } else {
    console.log(`\nDelta vs baseline: ${baselinePath}`);
    console.log(
      `  Recall@5: ${formatDelta(summary.metrics.recallAt5 * 100, baseline.metrics.recallAt5 * 100, 2, "%")}`
    );
    console.log(
      `  nDCG@10: ${formatDelta(summary.metrics.ndcgAt10 * 100, baseline.metrics.ndcgAt10 * 100, 2, "%")}`
    );
    console.log(
      `  MRR: ${formatDelta(summary.metrics.mrr * 100, baseline.metrics.mrr * 100, 2, "%")}`
    );
    console.log(
      `  total p95: ${formatDelta(summary.latencies.total.p95Ms, baseline.latencies.total.p95Ms, 2, "ms")}`
    );
    console.log(`\n${toDeltaMarkdown(baselinePath, baseline, summary)}`);
  }
}

if (args.has("--write")) {
  const outDir = join(import.meta.dir, "../evals/fixtures/hybrid-baseline");
  await mkdir(outDir, { recursive: true });

  const dateStamp = summary.generatedAt.slice(0, 10);
  const jsonPath = join(outDir, `${dateStamp}.json`);
  const latestJsonPath = join(outDir, "latest.json");
  const mdPath = join(outDir, `${dateStamp}.md`);
  const latestMdPath = join(outDir, "latest.md");

  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = toMarkdown(summary);

  await Bun.write(jsonPath, json);
  await Bun.write(latestJsonPath, json);
  await Bun.write(mdPath, markdown);
  await Bun.write(latestMdPath, markdown);

  console.log(`Wrote baseline artifacts:\n- ${jsonPath}\n- ${mdPath}`);
}
