#!/usr/bin/env bun
// node:fs/promises for artifact directory creation.
import { mkdir } from "node:fs/promises";
// node:path for portable artifact paths.
import { join } from "node:path";

import { runCodeEmbeddingBenchmark } from "../evals/helpers/code-embedding-benchmark";

interface CliOptions {
  candidate?: string;
  model?: string;
  label?: string;
  write: boolean;
  out?: string;
  dryRun: boolean;
  fixture?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { write: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    switch (arg) {
      case "--candidate":
        options.candidate = args[++index];
        break;
      case "--model":
        options.model = args[++index];
        break;
      case "--label":
        options.label = args[++index];
        break;
      case "--write":
        options.write = true;
        break;
      case "--out":
        options.out = args[++index];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--fixture":
        options.fixture = args[++index];
        break;
      default:
        throw new Error(
          `Unknown argument: ${arg}. Use --candidate <id> or --model <uri> [--label <name>] [--fixture <id>] [--write] [--out <path>] [--dry-run]`
        );
    }
  }
  return options;
}

async function resolveCandidate(
  candidateId: string
): Promise<{ id: string; label: string; embedModel: string }> {
  const searchSpace = (await Bun.file(
    join(import.meta.dir, "../research/embeddings/autonomous/search-space.json")
  ).json()) as {
    candidates: Array<{ id: string; label?: string; embedModel: string }>;
  };
  const candidate = searchSpace.candidates.find(
    (item) => item.id === candidateId
  );
  if (!candidate) {
    throw new Error(`Unknown candidate: ${candidateId}`);
  }
  return {
    id: candidate.id,
    label: candidate.label ?? candidate.id,
    embedModel: candidate.embedModel,
  };
}

function toMarkdown(
  summary: Awaited<ReturnType<typeof runCodeEmbeddingBenchmark>>
): string {
  const rows = summary.cases
    .map(
      (item) =>
        `| ${item.id} | ${item.caseSet} | ${item.vectorMetrics.ndcgAt10.toFixed(3)} | ${item.hybridMetrics.ndcgAt10.toFixed(3)} | ${item.vectorLatencyMs.toFixed(1)}ms | ${item.hybridLatencyMs.toFixed(1)}ms |`
    )
    .join("\n");

  return `# Code Embedding Benchmark

Generated: ${summary.generatedAt}
Model: \`${summary.label}\`
Embed URI: \`${summary.runtime.embedModel}\`

## Aggregate Metrics

| Mode | Recall@5 | Recall@10 | nDCG@10 | MRR | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vector | ${(summary.vector.metrics.recallAt5 * 100).toFixed(1)}% | ${(summary.vector.metrics.recallAt10 * 100).toFixed(1)}% | ${summary.vector.metrics.ndcgAt10.toFixed(3)} | ${summary.vector.metrics.mrr.toFixed(3)} | ${summary.vector.latency.p95Ms.toFixed(1)}ms |
| Hybrid | ${(summary.hybrid.metrics.recallAt5 * 100).toFixed(1)}% | ${(summary.hybrid.metrics.recallAt10 * 100).toFixed(1)}% | ${summary.hybrid.metrics.ndcgAt10.toFixed(3)} | ${summary.hybrid.metrics.mrr.toFixed(3)} | ${summary.hybrid.latency.p95Ms.toFixed(1)}ms |

## Cases

| Case | Set | Vector nDCG@10 | Hybrid nDCG@10 | Vector p50 | Hybrid p50 |
| --- | --- | ---: | ---: | ---: | ---: |
${rows}
`;
}

const options = parseArgs(process.argv.slice(2));

const candidate = options.candidate
  ? await resolveCandidate(options.candidate)
  : null;
const model = options.model ?? candidate?.embedModel;
if (!model) {
  throw new Error("Provide --candidate <id> or --model <uri>");
}

if (options.dryRun) {
  console.log(
    JSON.stringify(
      {
        candidateId: candidate?.id ?? null,
        label: options.label ?? candidate?.label ?? model,
        embedModel: model,
        fixture: options.fixture ?? "canonical",
        write: options.write,
        out: options.out ?? null,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const summary = await runCodeEmbeddingBenchmark({
  embedModel: model,
  label: options.label ?? candidate?.label ?? model,
  fixture: options.fixture,
});

console.log(
  `${options.label ?? candidate?.label ?? model}: vector nDCG@10=${summary.vector.metrics.ndcgAt10.toFixed(3)} hybrid nDCG@10=${summary.hybrid.metrics.ndcgAt10.toFixed(3)}`
);

const json = `${JSON.stringify(summary, null, 2)}\n`;

if (options.write) {
  const outDir = join(
    import.meta.dir,
    "../evals/fixtures/code-embedding-benchmark"
  );
  await mkdir(outDir, { recursive: true });
  const stamp = summary.generatedAt.slice(0, 10);
  await Bun.write(join(outDir, `${stamp}.json`), json);
  await Bun.write(join(outDir, `${stamp}.md`), `${toMarkdown(summary)}\n`);
  await Bun.write(join(outDir, "latest.json"), json);
  await Bun.write(join(outDir, "latest.md"), `${toMarkdown(summary)}\n`);
}

if (options.out) {
  await Bun.write(options.out, json);
}
