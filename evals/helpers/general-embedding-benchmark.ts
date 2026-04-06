/**
 * General embedding benchmark runner.
 * Evaluates embedding candidates on multilingual markdown/prose collections.
 *
 * @module evals/helpers/general-embedding-benchmark
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GnoClient } from "../../src/sdk/types";

import { createDefaultConfig } from "../../src/config";
import { createGnoClient } from "../../src/sdk";
import { computeMrr, computeNdcg, computeRecall } from "../scorers/ir-metrics";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "../fixtures/general-embedding-benchmark");

export interface GeneralEmbeddingBenchmarkCase {
  id: string;
  caseSet: "same-language" | "cross-language";
  queryLanguage: string;
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

export interface GeneralEmbeddingBenchmarkOptions {
  embedModel: string;
  label?: string;
  cacheDir?: string;
  dbPath?: string;
  limit?: number;
}

interface MetricSummary {
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
}

interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

interface CorpusSource {
  id: string;
  sourceRepo: string;
  commit: string;
  license: string;
  upstreamPath: string;
  language: string;
  topic: string;
}

interface CaseResult {
  id: string;
  caseSet: GeneralEmbeddingBenchmarkCase["caseSet"];
  query: string;
  queryLanguage: string;
  relevantDocs: string[];
  vectorTopDocs: string[];
  hybridTopDocs: string[];
  vectorMetrics: MetricSummary;
  hybridMetrics: MetricSummary;
  vectorLatencyMs: number;
  hybridLatencyMs: number;
}

export interface GeneralEmbeddingBenchmarkSummary {
  generatedAt: string;
  label: string;
  runtime: {
    embedModel: string;
    collection: string;
    corpusDir: string;
    queryCount: number;
    limit: number;
  };
  corpus: {
    docCount: number;
    languages: string[];
    topics: string[];
    sourceRepo: string;
    commit: string;
    license: string;
  };
  indexing: {
    embedded: number;
    errors: number;
    durationSeconds: number;
    searchAvailable: boolean;
  };
  vector: {
    metrics: MetricSummary;
    latency: LatencySummary;
  };
  hybrid: {
    metrics: MetricSummary;
    latency: LatencySummary;
  };
  bySet: Record<
    string,
    {
      vector: MetricSummary;
      hybrid: MetricSummary;
    }
  >;
  cases: CaseResult[];
}

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { p50Ms: 0, p95Ms: 0, meanMs: 0 };
  }
  return {
    p50Ms: round(percentile(values, 50), 2),
    p95Ms: round(percentile(values, 95), 2),
    meanMs: round(
      values.reduce((sum, value) => sum + value, 0) / values.length,
      2
    ),
  };
}

function summarizeMetrics(values: MetricSummary[]): MetricSummary {
  if (values.length === 0) {
    return { recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0 };
  }
  const average = (getter: (value: MetricSummary) => number) =>
    values.reduce((sum, item) => sum + getter(item), 0) / values.length;
  return {
    recallAt5: round(average((item) => item.recallAt5)),
    recallAt10: round(average((item) => item.recallAt10)),
    ndcgAt10: round(average((item) => item.ndcgAt10)),
    mrr: round(average((item) => item.mrr)),
  };
}

function computeMetrics(
  rankedDocs: string[],
  testCase: GeneralEmbeddingBenchmarkCase
): MetricSummary {
  const deduped = [...new Set(rankedDocs)];
  return {
    recallAt5: round(computeRecall(deduped, testCase.relevantDocs, 5)),
    recallAt10: round(computeRecall(deduped, testCase.relevantDocs, 10)),
    ndcgAt10: round(computeNdcg(deduped, testCase.judgments, 10)),
    mrr: round(computeMrr(deduped, testCase.relevantDocs)),
  };
}

async function loadCases(): Promise<GeneralEmbeddingBenchmarkCase[]> {
  return (await Bun.file(
    join(FIXTURE_ROOT, "queries.json")
  ).json()) as GeneralEmbeddingBenchmarkCase[];
}

async function loadSources(): Promise<CorpusSource[]> {
  return (await Bun.file(
    join(FIXTURE_ROOT, "sources.json")
  ).json()) as CorpusSource[];
}

async function listCorpusDocs(corpusDir: string): Promise<string[]> {
  const docs: string[] = [];
  const glob = new Bun.Glob("**/*.md");
  for await (const match of glob.scan({ cwd: corpusDir })) {
    docs.push(match);
  }
  docs.sort();
  return docs;
}

async function buildClient(
  input: GeneralEmbeddingBenchmarkOptions,
  tempDir: string
): Promise<GnoClient> {
  const config = createDefaultConfig();
  config.collections = [
    {
      name: "general-docs",
      path: join(FIXTURE_ROOT, "corpus"),
      pattern: "**/*.md",
      include: [".md"],
      exclude: [],
      languageHint: "und",
      models: { embed: input.embedModel },
    },
  ];

  return createGnoClient({
    config,
    dbPath: input.dbPath ?? join(tempDir, "general-embedding.sqlite"),
    cacheDir: input.cacheDir ?? join(tempDir, "cache"),
  });
}

export async function runGeneralEmbeddingBenchmark(
  input: GeneralEmbeddingBenchmarkOptions
): Promise<GeneralEmbeddingBenchmarkSummary> {
  const tempDir = await mkdtemp(join(tmpdir(), "gno-general-embed-bench-"));
  const corpusDir = join(FIXTURE_ROOT, "corpus");
  const cases = await loadCases();
  const sources = await loadSources();
  const corpusDocs = await listCorpusDocs(corpusDir);
  const client = await buildClient(input, tempDir);
  const limit = input.limit ?? 10;

  try {
    await client.index({ collection: "general-docs", noEmbed: true });
    const embedResult = await client.embed({ collection: "general-docs" });

    const caseResults: CaseResult[] = [];
    const vectorLatencies: number[] = [];
    const hybridLatencies: number[] = [];

    for (const testCase of cases) {
      const vectorStart = performance.now();
      const vectorResult = await client.vsearch(testCase.query, {
        collection: "general-docs",
        limit,
      });
      const vectorLatencyMs = performance.now() - vectorStart;
      vectorLatencies.push(vectorLatencyMs);

      const hybridStart = performance.now();
      const hybridResult = await client.query(testCase.query, {
        collection: "general-docs",
        limit,
        noExpand: true,
        noRerank: true,
      });
      const hybridLatencyMs = performance.now() - hybridStart;
      hybridLatencies.push(hybridLatencyMs);

      const vectorTopDocs = vectorResult.results.map(
        (item) => item.source.relPath
      );
      const hybridTopDocs = hybridResult.results.map(
        (item) => item.source.relPath
      );

      caseResults.push({
        id: testCase.id,
        caseSet: testCase.caseSet,
        query: testCase.query,
        queryLanguage: testCase.queryLanguage,
        relevantDocs: testCase.relevantDocs,
        vectorTopDocs,
        hybridTopDocs,
        vectorMetrics: computeMetrics(vectorTopDocs, testCase),
        hybridMetrics: computeMetrics(hybridTopDocs, testCase),
        vectorLatencyMs: round(vectorLatencyMs, 2),
        hybridLatencyMs: round(hybridLatencyMs, 2),
      });
    }

    const languages = [...new Set(sources.map((item) => item.language))];
    const topics = [...new Set(sources.map((item) => item.topic))];
    const bySet = Object.fromEntries(
      ["same-language", "cross-language"].map((caseSet) => {
        const subset = caseResults.filter((item) => item.caseSet === caseSet);
        return [
          caseSet,
          {
            vector: summarizeMetrics(subset.map((item) => item.vectorMetrics)),
            hybrid: summarizeMetrics(subset.map((item) => item.hybridMetrics)),
          },
        ];
      })
    );

    return {
      generatedAt: new Date().toISOString(),
      label: input.label ?? input.embedModel,
      runtime: {
        embedModel: input.embedModel,
        collection: "general-docs",
        corpusDir,
        queryCount: cases.length,
        limit,
      },
      corpus: {
        docCount: corpusDocs.length,
        languages,
        topics,
        sourceRepo: sources[0]?.sourceRepo ?? "",
        commit: sources[0]?.commit ?? "",
        license: sources[0]?.license ?? "",
      },
      indexing: {
        embedded: embedResult.embedded,
        errors: embedResult.errors,
        durationSeconds: round(embedResult.duration, 2),
        searchAvailable: embedResult.searchAvailable,
      },
      vector: {
        metrics: summarizeMetrics(
          caseResults.map((item) => item.vectorMetrics)
        ),
        latency: summarizeLatency(vectorLatencies),
      },
      hybrid: {
        metrics: summarizeMetrics(
          caseResults.map((item) => item.hybridMetrics)
        ),
        latency: summarizeLatency(hybridLatencies),
      },
      bySet,
      cases: caseResults,
    };
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
