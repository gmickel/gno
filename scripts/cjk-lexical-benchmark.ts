// node:fs/promises: recursive artifact directory creation has no Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import { runCjkLexicalBenchmark } from "../evals/helpers/cjk-lexical-benchmark";
import { renderCjkBenchmarkMarkdown } from "../evals/helpers/cjk-lexical-report";

const args = new Set(process.argv.slice(2));
const result = await runCjkLexicalBenchmark();

console.log(
  `CJK lexical benchmark: ${result.corpus.documentCount} documents, ${result.corpus.queryCount} queries`
);
for (const lane of result.lanes) {
  console.log(`\n${lane.id}`);
  for (const language of lane.languages) {
    console.log(
      `  ${language.language}: R@5=${language.metrics.recallAt5.toFixed(4)} R@10=${language.metrics.recallAt10.toFixed(4)} MRR=${language.metrics.mrr.toFixed(4)} nDCG@10=${language.metrics.ndcgAt10.toFixed(4)} zero=${language.metrics.zeroResultRate.toFixed(4)}`
    );
  }
  console.log(
    `  latency: cold=${lane.latency.coldQueryMs.toFixed(2)}ms warm-p50=${lane.latency.warmQuery.p50Ms.toFixed(2)}ms warm-p95=${lane.latency.warmQuery.p95Ms.toFixed(2)}ms`
  );
}
console.log(`\nStable result fingerprint: ${result.fingerprints.result}`);

if (args.has("--write")) {
  const outputDirectory = join(
    import.meta.dir,
    "../evals/fixtures/cjk-lexical-benchmark"
  );
  await mkdir(outputDirectory, { recursive: true });
  const date = result.generatedAt.slice(0, 10);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderCjkBenchmarkMarkdown(result);
  await Promise.all([
    Bun.write(join(outputDirectory, `${date}.json`), json),
    Bun.write(join(outputDirectory, "latest.json"), json),
    Bun.write(join(outputDirectory, `${date}.md`), markdown),
    Bun.write(join(outputDirectory, "latest.md"), markdown),
  ]);
  console.log(
    `Wrote dated and latest JSON/Markdown artifacts to ${outputDirectory}`
  );
}
