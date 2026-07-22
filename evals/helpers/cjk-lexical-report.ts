import type {
  CjkBenchFailure,
  CjkBenchLaneResult,
  CjkBenchOutput,
} from "../../src/bench/types";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const languageRows = (lane: CjkBenchLaneResult): string =>
  lane.languages
    .map(
      (result) =>
        `| ${lane.id} | ${result.language} | ${result.queryCount} | ${percent(result.metrics.recallAt5)} | ${percent(result.metrics.recallAt10)} | ${result.metrics.mrr.toFixed(4)} | ${result.metrics.ndcgAt10.toFixed(4)} | ${percent(result.metrics.zeroResultRate)} |`
    )
    .join("\n");

const formatFailure = (lane: string, failure: CjkBenchFailure): string =>
  `| ${lane} | ${failure.language} | ${failure.queryId} | ${failure.category} | ${failure.reason} | ${failure.query.replaceAll("|", "\\|")} | ${failure.expected.join(", ")} | ${failure.topDocs.join(", ") || "—"} |`;

export const renderCjkBenchmarkMarkdown = (result: CjkBenchOutput): string => {
  const failureRows = result.lanes.flatMap((lane) =>
    lane.languages.flatMap((language) =>
      language.failures.map((failure) => formatFailure(lane.id, failure))
    )
  );
  return `# CJK Lexical Degradation Benchmark

Generated: ${result.generatedAt}

This deterministic same-language benchmark measures Chinese, Japanese, and Korean retrieval when no embedding, expansion, or reranking model is available. It is a small synthetic diagnostic corpus, not a claim of complete CJK coverage.

## Reproducibility

- Schema: ${result.schemaVersion}
- Corpus: ${result.corpus.documentCount} documents, ${result.corpus.queryCount} queries
- Corpus fingerprint: \`${result.corpus.fingerprint}\`
- Configuration fingerprint: \`${result.fingerprints.config}\`
- Runtime fingerprint: \`${result.fingerprints.runtime}\`
- Tokenizer fingerprint: \`${result.fingerprints.tokenizer}\`
- Stable result fingerprint: \`${result.fingerprints.result}\`
- Tokenizer: \`${result.index.tokenizer}\`
- Runtime: Bun ${result.runtime.bun}, ${result.runtime.platform}-${result.runtime.arch}, SQLite ${result.runtime.sqlite}
- Provenance: ${result.corpus.provenance}

The stable result fingerprint excludes \`generatedAt\` and all millisecond timing fields. Timings remain machine-specific evidence. All positive qrels currently use relevance 3, so nDCG measures rank placement but not distinctions among multiple positive gain grades.

## Index cost

| Build | Size | Pages | Page size | Vocabulary terms | Vocabulary documents | Token occurrences |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${result.index.buildMs.toFixed(2)} ms | ${result.index.bytes} bytes | ${result.index.pageCount} | ${result.index.pageSize} | ${result.index.vocabularyTerms} | ${result.index.vocabularyDocuments} | ${result.index.tokenOccurrences} |

## Per-language quality

| Lane | Language | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Zero-result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${result.lanes.map(languageRows).join("\n")}

## Latency

| Lane | Cold query | Warm p50 | Warm p95 | Warm mean |
| --- | ---: | ---: | ---: | ---: |
${result.lanes
  .map(
    (lane) =>
      `| ${lane.id} | ${lane.latency.coldQueryMs.toFixed(2)} ms | ${lane.latency.warmQuery.p50Ms.toFixed(2)} ms | ${lane.latency.warmQuery.p95Ms.toFixed(2)} ms | ${lane.latency.warmQuery.meanMs.toFixed(2)} ms |`
  )
  .join("\n")}

Cold query is the first timed request for each lane after index construction. Warm latency is measured after one untimed full-corpus pass.

## Categorized failures

| Lane | Language | Query | Category | Reason | Query text | Expected | Top documents |
| --- | --- | --- | --- | --- | --- | --- | --- |
${failureRows.length > 0 ? failureRows.join("\n") : "| — | — | — | — | — | No failures | — | — |"}

Diagnostic substring lanes inspect title and document content only; opaque corpus paths never participate in matching. They are benchmark-only and do not change production tokenization or retrieval.
`;
};
