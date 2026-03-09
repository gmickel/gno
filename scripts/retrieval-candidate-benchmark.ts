#!/usr/bin/env bun
// node:fs/promises for artifact directory creation.
import { mkdir } from "node:fs/promises";
// node:path for portable artifact paths.
import { join } from "node:path";

import {
  type CandidateBenchmarkResult,
  runRetrievalCandidateBenchmark,
} from "../evals/helpers/retrieval-candidate-benchmark";
import { RETRIEVAL_CANDIDATES } from "../evals/helpers/retrieval-candidate-matrix";

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatGiB(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) {
    return "n/a";
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatMillis(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function toMarkdownCandidateRow(candidate: CandidateBenchmarkResult): string {
  if (!candidate.ok) {
    return `| ${candidate.candidate.label} | fail | fail | fail | fail | fail | ${candidate.error ?? "unknown error"} |`;
  }
  const askRecall = candidate.retrieval.bySet.ask?.metric.recallAt5 ?? 0;
  return `| ${candidate.candidate.label} | ${formatPercent(candidate.expansion.schemaSuccessRate)} | ${formatPercent(candidate.expansion.cleanJsonRate)} | ${candidate.retrieval.metrics.ndcgAt10.toFixed(3)} | ${askRecall.toFixed(3)} | ${formatMillis(candidate.retrieval.latencies.total.p95Ms)} | ${formatGiB(candidate.load.rssDeltaBytes)} |`;
}

function renderRecommendationHint(
  summary: Awaited<ReturnType<typeof runRetrievalCandidateBenchmark>>
): string {
  const bestRetrieval = summary.recommendation.bestRetrievalId ?? "none";
  const bestAnswer = summary.recommendation.bestAnswerSmokeId ?? "none";
  return [
    "## Provisional Recommendation",
    "",
    `- Expansion winner by measured score: \`${bestRetrieval}\``,
    `- Answer smoke winner: \`${bestAnswer}\``,
    "- Reranker path: keep current Qwen3-Reranker unless a later epic lands a realistic drop-in.",
  ].join("\n");
}

function renderMarkdown(
  summary: Awaited<ReturnType<typeof runRetrievalCandidateBenchmark>>
): string {
  const selectedCandidates = summary.candidates
    .map((candidate) => toMarkdownCandidateRow(candidate))
    .join("\n");

  return `# Next-Generation Retrieval Candidate Benchmark

Generated: ${summary.generatedAt}

## Runtime

- Platform: ${summary.host.platform}/${summary.host.arch}
- Bun: ${summary.host.bunVersion}
- Embed model: \`${summary.runtime.embedModel}\`
- Rerank model: \`${summary.runtime.rerankModel}\`
- sqlite-vec available: ${summary.runtime.vectorAvailable ? "yes" : "no"}
- Retrieval cases: ${summary.runtime.retrievalCaseCount}
- Answer smoke cases: ${summary.runtime.answerSmokeCaseCount}

## Candidate Matrix

| Candidate | Schema | Clean JSON | nDCG@10 | Ask R@5 | Total p95 | RSS delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${selectedCandidates}

${renderRecommendationHint(summary)}
`;
}

const args = new Set(process.argv.slice(2));
const selectedIds = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"))
  .filter((arg) =>
    RETRIEVAL_CANDIDATES.some((candidate) => candidate.id === arg)
  );

const summary = await runRetrievalCandidateBenchmark(selectedIds);

for (const candidate of summary.candidates) {
  if (!candidate.ok) {
    console.log(`${candidate.candidate.id}: failed - ${candidate.error}`);
    continue;
  }
  const askRecall = candidate.retrieval.bySet.ask?.metric.recallAt5 ?? 0;
  console.log(
    `${candidate.candidate.id}: nDCG@10=${candidate.retrieval.metrics.ndcgAt10.toFixed(3)} askR@5=${askRecall.toFixed(3)} p95=${candidate.retrieval.latencies.total.p95Ms.toFixed(1)}ms schema=${(candidate.expansion.schemaSuccessRate * 100).toFixed(1)}%`
  );
}

if (args.has("--write")) {
  const outDir = join(
    import.meta.dir,
    "../evals/fixtures/retrieval-candidate-benchmark"
  );
  await mkdir(outDir, { recursive: true });
  const dateStamp = summary.generatedAt.slice(0, 10);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = `${renderMarkdown(summary)}\n`;
  await Bun.write(join(outDir, `${dateStamp}.json`), json);
  await Bun.write(join(outDir, `${dateStamp}.md`), markdown);
  await Bun.write(join(outDir, "latest.json"), json);
  await Bun.write(join(outDir, "latest.md"), markdown);
  console.log(`Wrote retrieval benchmark artifacts to ${outDir}`);
}
