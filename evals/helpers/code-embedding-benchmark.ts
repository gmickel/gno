/**
 * Code embedding benchmark runner.
 * Evaluates candidate embedding models against a small multi-language code corpus.
 *
 * @module evals/helpers/code-embedding-benchmark
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
const FIXTURE_ROOT = join(__dirname, "../fixtures/code-embedding-benchmark");
const CORPUS_DIR = join(FIXTURE_ROOT, "corpus");
const QUERIES_PATH = join(FIXTURE_ROOT, "queries.json");
const COLLECTION = "codebench";

export interface CodeEmbeddingBenchmarkCase {
  id: string;
  caseSet: "nl2code" | "identifier";
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

export interface CodeEmbeddingBenchmarkOptions {
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

interface CaseResult {
  id: string;
  caseSet: CodeEmbeddingBenchmarkCase["caseSet"];
  query: string;
  relevantDocs: string[];
  vectorTopDocs: string[];
  hybridTopDocs: string[];
  vectorMetrics: MetricSummary;
  hybridMetrics: MetricSummary;
  vectorLatencyMs: number;
  hybridLatencyMs: number;
}

export interface CodeEmbeddingBenchmarkSummary {
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
  testCase: CodeEmbeddingBenchmarkCase
): MetricSummary {
  return {
    recallAt5: round(computeRecall(rankedDocs, testCase.relevantDocs, 5)),
    recallAt10: round(computeRecall(rankedDocs, testCase.relevantDocs, 10)),
    ndcgAt10: round(computeNdcg(rankedDocs, testCase.judgments, 10)),
    mrr: round(computeMrr(rankedDocs, testCase.relevantDocs)),
  };
}

async function loadCases(): Promise<CodeEmbeddingBenchmarkCase[]> {
  return (await Bun.file(QUERIES_PATH).json()) as CodeEmbeddingBenchmarkCase[];
}

async function buildClient(
  input: CodeEmbeddingBenchmarkOptions,
  tempDir: string
): Promise<GnoClient> {
  const config = createDefaultConfig();
  config.collections = [
    {
      name: COLLECTION,
      path: CORPUS_DIR,
      pattern: "**/*",
      include: [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
      exclude: [],
      models: { embed: input.embedModel },
    },
  ];

  return createGnoClient({
    config,
    dbPath: input.dbPath ?? join(tempDir, "code-embedding.sqlite"),
    cacheDir: input.cacheDir ?? join(tempDir, "cache"),
  });
}

async function listCorpusDocs(): Promise<string[]> {
  const docs: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,py,go,rs}");
  for await (const match of glob.scan({ cwd: CORPUS_DIR })) {
    docs.push(match);
  }
  docs.sort();
  return docs;
}

export async function runCodeEmbeddingBenchmark(
  input: CodeEmbeddingBenchmarkOptions
): Promise<CodeEmbeddingBenchmarkSummary> {
  const tempDir = await mkdtemp(join(tmpdir(), "gno-code-embed-bench-"));
  const cases = await loadCases();
  const corpusDocs = await listCorpusDocs();
  const client = await buildClient(input, tempDir);
  const limit = input.limit ?? 10;

  try {
    await client.index({ collection: COLLECTION, noEmbed: true });
    const embedResult = await client.embed({ collection: COLLECTION });

    const caseResults: CaseResult[] = [];
    const vectorLatencies: number[] = [];
    const hybridLatencies: number[] = [];

    for (const testCase of cases) {
      const vectorStart = performance.now();
      const vectorResult = await client.vsearch(testCase.query, {
        collection: COLLECTION,
        limit,
      });
      const vectorLatencyMs = performance.now() - vectorStart;
      vectorLatencies.push(vectorLatencyMs);

      const hybridStart = performance.now();
      const hybridResult = await client.query(testCase.query, {
        collection: COLLECTION,
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
        relevantDocs: testCase.relevantDocs,
        vectorTopDocs,
        hybridTopDocs,
        vectorMetrics: computeMetrics(vectorTopDocs, testCase),
        hybridMetrics: computeMetrics(hybridTopDocs, testCase),
        vectorLatencyMs: round(vectorLatencyMs, 2),
        hybridLatencyMs: round(hybridLatencyMs, 2),
      });
    }

    const bySet = Object.fromEntries(
      ["nl2code", "identifier"].map((caseSet) => {
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
        collection: COLLECTION,
        corpusDir: CORPUS_DIR,
        queryCount: cases.length,
        limit,
      },
      corpus: {
        docCount: corpusDocs.length,
        languages: ["typescript", "javascript", "python", "go", "rust"],
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
