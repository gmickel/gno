/**
 * gno bench command implementation.
 * Runs retrieval benchmarks from user fixtures.
 *
 * @module src/cli/commands/bench
 */

import type {
  BenchCase,
  BenchCaseResult,
  BenchMode,
  BenchModeResult,
  BenchOptions,
  BenchResult,
} from "../../bench/types";
import type { SearchResult } from "../../pipeline/types";

import { loadBenchFixture, normalizeBenchRef } from "../../bench/fixture";
import { averageMetrics, computeRetrievalMetrics } from "../../bench/metrics";
import { DEFAULT_THOROUGH_CANDIDATE_LIMIT } from "../../core/depth-policy";
import { query } from "./query";
import { search } from "./search";
import { vsearch } from "./vsearch";

function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

function summarizeLatency(values: number[]): BenchModeResult["latency"] {
  if (values.length === 0) {
    return { p50Ms: 0, p95Ms: 0, meanMs: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
  };
  return {
    p50Ms: round(percentile(50)),
    p95Ms: round(percentile(95)),
    meanMs: round(
      values.reduce((sum, value) => sum + value, 0) / values.length
    ),
  };
}

function resultRefs(result: SearchResult): Set<string> {
  return new Set(
    [
      result.docid,
      result.uri,
      normalizeBenchRef(result.uri),
      result.source.relPath,
      result.title,
    ].filter((value): value is string => Boolean(value))
  );
}

function findHits(
  results: SearchResult[],
  expected: string[],
  k: number
): string[] {
  const hits: string[] = [];
  const expectedSet = new Set(expected.map(normalizeBenchRef));

  for (const result of results.slice(0, k)) {
    const refs = resultRefs(result);
    const hit = [...expectedSet].find((expectedRef) => refs.has(expectedRef));
    if (hit && !hits.includes(hit)) {
      hits.push(hit);
    }
  }

  return hits;
}

function topDocs(results: SearchResult[]): string[] {
  return results.map((result) => result.source.relPath);
}

function rankedMetricDocs(
  results: SearchResult[],
  expected: string[]
): string[] {
  const expectedSet = new Set(expected.map(normalizeBenchRef));
  return results.map((result) => {
    const refs = resultRefs(result);
    return (
      [...expectedSet].find((expectedRef) => refs.has(expectedRef)) ??
      result.source.relPath
    );
  });
}

async function runModeCase(input: {
  mode: BenchMode;
  benchCase: BenchCase;
  topK: number;
  candidateLimit?: number;
  options: BenchOptions;
}): Promise<BenchCaseResult> {
  const { mode, benchCase, topK, options } = input;
  const limit = mode.limit ?? topK;
  const candidateLimit =
    mode.candidateLimit ??
    input.candidateLimit ??
    (mode.depth === "thorough" ? DEFAULT_THOROUGH_CANDIDATE_LIMIT : undefined);
  const startedAt = performance.now();
  const queryModes = benchCase.queryModes ?? mode.queryModes;
  let result:
    | Awaited<ReturnType<typeof search>>
    | Awaited<ReturnType<typeof vsearch>>
    | Awaited<ReturnType<typeof query>>;

  if (mode.type === "bm25") {
    result = await search(benchCase.query, {
      configPath: options.configPath,
      indexName: options.indexName,
      collection: benchCase.collection,
      limit,
      json: true,
    });
  } else if (mode.type === "vector") {
    result = await vsearch(benchCase.query, {
      configPath: options.configPath,
      indexName: options.indexName,
      collection: benchCase.collection,
      limit,
      json: true,
    });
  } else {
    result = await query(benchCase.query, {
      configPath: options.configPath,
      indexName: options.indexName,
      collection: benchCase.collection,
      limit,
      candidateLimit,
      noExpand: mode.noExpand,
      noRerank: mode.noRerank,
      queryModes,
      json: true,
    });
  }

  const latencyMs = round(performance.now() - startedAt);
  if (!result.success) {
    return {
      id: benchCase.id,
      query: benchCase.query,
      topK,
      expected: benchCase.expected,
      hits: [],
      topDocs: [],
      metrics: computeRetrievalMetrics({
        output: [],
        expected: benchCase.expected,
        judgments: benchCase.judgments,
        k: topK,
      }),
      latencyMs,
      error: result.error,
    };
  }

  const docs = topDocs(result.data.results);
  const metricDocs = rankedMetricDocs(result.data.results, benchCase.expected);
  const hits = findHits(result.data.results, benchCase.expected, topK);
  return {
    id: benchCase.id,
    query: benchCase.query,
    topK,
    expected: benchCase.expected,
    hits,
    topDocs: docs.slice(0, topK),
    metrics: computeRetrievalMetrics({
      output: metricDocs,
      expected: benchCase.expected,
      judgments: benchCase.judgments,
      k: topK,
    }),
    latencyMs,
  };
}

/**
 * Execute gno bench command.
 */
export async function bench(
  fixturePath: string,
  options: BenchOptions = {}
): Promise<BenchResult> {
  const loaded = await loadBenchFixture(fixturePath, options);
  if (!loaded.ok) {
    return { success: false, error: loaded.error, isValidation: true };
  }

  const { fixture } = loaded;
  const modeResults: BenchModeResult[] = [];

  for (const mode of fixture.modes) {
    const cases: BenchCaseResult[] = [];
    for (const benchCase of fixture.queries) {
      const topK = benchCase.topK ?? fixture.topK;
      cases.push(
        await runModeCase({
          mode,
          benchCase,
          topK,
          candidateLimit: fixture.candidateLimit,
          options,
        })
      );
    }

    const failures = cases.filter((entry) => entry.error).length;
    modeResults.push({
      name: mode.name,
      type: mode.type,
      status: failures === cases.length ? "failed" : "ok",
      queryCount: cases.length,
      failures,
      metrics: averageMetrics(cases.map((entry) => entry.metrics)),
      latency: summarizeLatency(cases.map((entry) => entry.latencyMs)),
      cases,
    });
  }

  return {
    success: true,
    data: {
      fixture: {
        path: fixturePath,
        name: fixture.metadata?.name,
        version: fixture.version,
        queryCount: fixture.queries.length,
        topK: fixture.topK,
      },
      generatedAt: new Date().toISOString(),
      modes: modeResults,
      meta: {
        indexName: options.indexName ?? "default",
        collection: fixture.collection,
      },
    },
  };
}

export function formatBench(
  result: BenchResult,
  options: { json?: boolean }
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: "BENCH_FAILED", message: result.error },
        })
      : `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.data, null, 2);
  }

  const lines = [
    `Bench: ${result.data.fixture.name ?? result.data.fixture.path}`,
    `Queries: ${result.data.fixture.queryCount}  Top K: ${result.data.fixture.topK}`,
    "",
    "| Mode | Status | Precision@K | Recall@K | F1@K | MRR | nDCG@K | p95 ms | Failures |",
    "| ---- | ------ | ----------- | -------- | ---- | --- | ------ | ------ | -------- |",
  ];

  for (const mode of result.data.modes) {
    lines.push(
      `| ${mode.name} | ${mode.status} | ${mode.metrics.precisionAtK.toFixed(3)} | ${mode.metrics.recallAtK.toFixed(3)} | ${mode.metrics.f1AtK.toFixed(3)} | ${mode.metrics.mrr.toFixed(3)} | ${mode.metrics.ndcgAtK.toFixed(3)} | ${mode.latency.p95Ms.toFixed(2)} | ${mode.failures} |`
    );
  }

  return lines.join("\n");
}
