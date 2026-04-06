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
  fixture?: string;
}

interface CodeEmbeddingFixture {
  id: string;
  label: string;
  collection: string;
  corpusDir: string;
  queriesPath: string;
  include: string[];
  languages: string[];
  sourceManifestPath?: string;
}

interface SourceFixtureFile {
  id: string;
  label: string;
  repoUrl: string;
  repoPath: string;
  commit: string;
  relativePath: string;
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
  const dedupedRankedDocs = dedupeRankedDocs(rankedDocs);
  return {
    recallAt5: round(
      computeRecall(dedupedRankedDocs, testCase.relevantDocs, 5)
    ),
    recallAt10: round(
      computeRecall(dedupedRankedDocs, testCase.relevantDocs, 10)
    ),
    ndcgAt10: round(computeNdcg(dedupedRankedDocs, testCase.judgments, 10)),
    mrr: round(computeMrr(dedupedRankedDocs, testCase.relevantDocs)),
  };
}

export function dedupeRankedDocs(rankedDocs: string[]): string[] {
  return [...new Set(rankedDocs)];
}

async function loadCases(): Promise<CodeEmbeddingBenchmarkCase[]> {
  throw new Error("use loadCasesForFixture");
}

async function buildClient(
  input: CodeEmbeddingBenchmarkOptions,
  tempDir: string,
  fixture: CodeEmbeddingFixture
): Promise<GnoClient> {
  const config = createDefaultConfig();
  config.collections = [
    {
      name: fixture.collection,
      path: fixture.corpusDir,
      pattern: "**/*",
      include: fixture.include,
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

async function loadFixtures(): Promise<CodeEmbeddingFixture[]> {
  return (await Bun.file(
    join(FIXTURE_ROOT, "fixtures.json")
  ).json()) as CodeEmbeddingFixture[];
}

async function loadFixture(id?: string): Promise<CodeEmbeddingFixture> {
  const fixtures = await loadFixtures();
  const fixtureId = id ?? "canonical";
  const fixture = fixtures.find((item) => item.id === fixtureId);
  if (!fixture) {
    throw new Error(`Unknown code embedding fixture: ${fixtureId}`);
  }
  return fixture;
}

async function loadCasesForFixture(
  fixture: CodeEmbeddingFixture
): Promise<CodeEmbeddingBenchmarkCase[]> {
  return (await Bun.file(
    fixture.queriesPath
  ).json()) as CodeEmbeddingBenchmarkCase[];
}

async function loadSourceManifest(
  fixture: CodeEmbeddingFixture
): Promise<SourceFixtureFile[]> {
  if (!fixture.sourceManifestPath) {
    return [];
  }
  return (await Bun.file(
    fixture.sourceManifestPath
  ).json()) as SourceFixtureFile[];
}

async function materializeFixtureCorpus(
  fixture: CodeEmbeddingFixture,
  tempDir: string
): Promise<string> {
  if (!fixture.sourceManifestPath) {
    return fixture.corpusDir;
  }

  const manifest = await loadSourceManifest(fixture);
  const corpusDir = join(tempDir, `fixture-${fixture.id}`);
  for (const entry of manifest) {
    const sourcePath = join(entry.repoPath, entry.relativePath);
    const sourceFile = Bun.file(sourcePath);
    if (!(await sourceFile.exists())) {
      throw new Error(`Missing OSS source file: ${sourcePath}`);
    }
    const outputPath = join(corpusDir, entry.id, entry.relativePath);
    await Bun.write(outputPath, await sourceFile.text());
  }
  return corpusDir;
}

async function listCorpusDocs(
  corpusDir: string,
  include: string[]
): Promise<string[]> {
  const docs: string[] = [];
  for (const ext of include) {
    const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
    const glob = new Bun.Glob(`**/*.${normalized}`);
    for await (const match of glob.scan({ cwd: corpusDir })) {
      docs.push(match);
    }
  }
  docs.sort();
  return docs;
}

export async function runCodeEmbeddingBenchmark(
  input: CodeEmbeddingBenchmarkOptions
): Promise<CodeEmbeddingBenchmarkSummary> {
  const fixture = await loadFixture(input.fixture);
  const tempDir = await mkdtemp(join(tmpdir(), "gno-code-embed-bench-"));
  const corpusDir = await materializeFixtureCorpus(fixture, tempDir);
  const cases = await loadCasesForFixture(fixture);
  const corpusDocs = await listCorpusDocs(corpusDir, fixture.include);
  const client = await buildClient(
    {
      ...input,
    },
    tempDir,
    {
      ...fixture,
      corpusDir,
    }
  );
  const limit = input.limit ?? 10;

  try {
    await client.index({ collection: fixture.collection, noEmbed: true });
    const embedResult = await client.embed({ collection: fixture.collection });

    const caseResults: CaseResult[] = [];
    const vectorLatencies: number[] = [];
    const hybridLatencies: number[] = [];

    for (const testCase of cases) {
      const vectorStart = performance.now();
      const vectorResult = await client.vsearch(testCase.query, {
        collection: fixture.collection,
        limit,
      });
      const vectorLatencyMs = performance.now() - vectorStart;
      vectorLatencies.push(vectorLatencyMs);

      const hybridStart = performance.now();
      const hybridResult = await client.query(testCase.query, {
        collection: fixture.collection,
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
        collection: fixture.collection,
        corpusDir,
        queryCount: cases.length,
        limit,
      },
      corpus: {
        docCount: corpusDocs.length,
        languages: fixture.languages,
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
