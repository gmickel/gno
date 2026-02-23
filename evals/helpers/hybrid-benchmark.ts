/**
 * Shared hybrid benchmark runner for eval + baseline snapshots.
 *
 * @module evals/helpers/hybrid-benchmark
 */

import type { Config } from "../../src/config/types";
import type { ExplainLine } from "../../src/pipeline/types";
import type { QueryModeInput } from "../../src/pipeline/types";

import { CONFIG_VERSION, DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { searchHybrid } from "../../src/pipeline/hybrid";
import adversarialJson from "../fixtures/hybrid-adversarial.json";
import queriesJson from "../fixtures/queries.json";
import { computeMrr, computeNdcg, computeRecall } from "../scorers/ir-metrics";
import { getSharedEvalDb } from "./setup-db";

interface QueryFixture {
  id: string;
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

interface AdversarialFixture extends QueryFixture {
  category:
    | "entity"
    | "phrase"
    | "negation"
    | "ambiguous"
    | "acronym"
    | "near-miss";
  queryModes?: QueryModeInput[];
}

interface HybridCase extends QueryFixture {
  category: string;
  queryModes?: QueryModeInput[];
}

interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

interface StageTimings {
  langMs: number;
  expansionMs: number;
  bm25Ms: number;
  vectorMs: number;
  fusionMs: number;
  rerankMs: number;
  assemblyMs: number;
  totalMs: number;
}

interface BenchmarkCaseResult {
  id: string;
  category: string;
  query: string;
  topDocs: string[];
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  timings: StageTimings;
}

export interface HybridBenchmarkSummary {
  generatedAt: string;
  corpusDocs: number;
  caseCount: number;
  metrics: {
    recallAt5: number;
    recallAt10: number;
    ndcgAt10: number;
    mrr: number;
  };
  latencies: {
    total: LatencySummary;
    byStage: {
      lang: LatencySummary;
      expansion: LatencySummary;
      bm25: LatencySummary;
      vector: LatencySummary;
      fusion: LatencySummary;
      rerank: LatencySummary;
      assembly: LatencySummary;
    };
  };
  cases: BenchmarkCaseResult[];
}

const BENCH_CONFIG: Config = {
  version: CONFIG_VERSION,
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: [],
  contexts: [],
};

function buildHybridCases(): HybridCase[] {
  const baselineCases = (queriesJson as QueryFixture[])
    .filter((q) => !q.id.startsWith("ml"))
    .map((q) => ({ ...q, category: "baseline" }));
  const adversarialCases = adversarialJson as AdversarialFixture[];
  return [...baselineCases, ...adversarialCases];
}

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[clamped] ?? 0;
}

function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { p50Ms: 0, p95Ms: 0, meanMs: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    p50Ms: round(percentile(values, 50), 2),
    p95Ms: round(percentile(values, 95), 2),
    meanMs: round(total / values.length, 2),
  };
}

function parseTimingsFromExplain(
  lines: ExplainLine[] | undefined,
  fallbackTotalMs: number
): StageTimings {
  const fallback: StageTimings = {
    langMs: 0,
    expansionMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
    fusionMs: 0,
    rerankMs: 0,
    assemblyMs: 0,
    totalMs: fallbackTotalMs,
  };

  if (!lines) {
    return fallback;
  }

  const timingLine = lines.find((line) => line.stage === "timing");
  if (!timingLine) {
    return fallback;
  }

  const timings: StageTimings = { ...fallback };
  for (const match of timingLine.message.matchAll(
    /([a-z]+)=([0-9]+(?:\.[0-9]+)?)ms/g
  )) {
    const key = match[1];
    const value = Number(match[2]);
    if (!Number.isFinite(value) || !key) {
      continue;
    }
    switch (key) {
      case "lang":
        timings.langMs = value;
        break;
      case "expansion":
        timings.expansionMs = value;
        break;
      case "bm25":
        timings.bm25Ms = value;
        break;
      case "vector":
        timings.vectorMs = value;
        break;
      case "fusion":
        timings.fusionMs = value;
        break;
      case "rerank":
        timings.rerankMs = value;
        break;
      case "assembly":
        timings.assemblyMs = value;
        break;
      case "total":
        timings.totalMs = value;
        break;
      default:
        break;
    }
  }

  return timings;
}

export async function runHybridBenchmark(): Promise<HybridBenchmarkSummary> {
  const ctx = await getSharedEvalDb();
  const cases = buildHybridCases();

  const recallAt5: number[] = [];
  const recallAt10: number[] = [];
  const ndcgAt10: number[] = [];
  const mrr: number[] = [];

  const langMs: number[] = [];
  const expansionMs: number[] = [];
  const bm25Ms: number[] = [];
  const vectorMs: number[] = [];
  const fusionMs: number[] = [];
  const rerankMs: number[] = [];
  const assemblyMs: number[] = [];
  const totalMs: number[] = [];

  const results: BenchmarkCaseResult[] = [];

  for (const testCase of cases) {
    const start = performance.now();
    const result = await searchHybrid(
      {
        store: ctx.adapter,
        config: BENCH_CONFIG,
        vectorIndex: null,
        embedPort: null,
        genPort: null,
        rerankPort: null,
      },
      testCase.query,
      {
        collection: "eval",
        limit: 10,
        noExpand: true,
        noRerank: true,
        queryModes: testCase.queryModes,
        explain: true,
      }
    );

    const durationMs = performance.now() - start;
    const docids = result.ok
      ? result.value.results.map((entry) => entry.source.relPath)
      : [];
    const timings = result.ok
      ? parseTimingsFromExplain(result.value.meta.explain?.lines, durationMs)
      : parseTimingsFromExplain(undefined, durationMs);

    const caseRecall5 = computeRecall(docids, testCase.relevantDocs, 5);
    const caseRecall10 = computeRecall(docids, testCase.relevantDocs, 10);
    const caseNdcg10 = computeNdcg(docids, testCase.judgments, 10);
    const caseMrr = computeMrr(docids, testCase.relevantDocs);

    recallAt5.push(caseRecall5);
    recallAt10.push(caseRecall10);
    ndcgAt10.push(caseNdcg10);
    mrr.push(caseMrr);

    langMs.push(timings.langMs);
    expansionMs.push(timings.expansionMs);
    bm25Ms.push(timings.bm25Ms);
    vectorMs.push(timings.vectorMs);
    fusionMs.push(timings.fusionMs);
    rerankMs.push(timings.rerankMs);
    assemblyMs.push(timings.assemblyMs);
    totalMs.push(timings.totalMs);

    results.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      topDocs: docids.slice(0, 5),
      recallAt5: round(caseRecall5),
      recallAt10: round(caseRecall10),
      ndcgAt10: round(caseNdcg10),
      mrr: round(caseMrr),
      timings: {
        langMs: round(timings.langMs, 2),
        expansionMs: round(timings.expansionMs, 2),
        bm25Ms: round(timings.bm25Ms, 2),
        vectorMs: round(timings.vectorMs, 2),
        fusionMs: round(timings.fusionMs, 2),
        rerankMs: round(timings.rerankMs, 2),
        assemblyMs: round(timings.assemblyMs, 2),
        totalMs: round(timings.totalMs, 2),
      },
    });
  }

  const average = (values: number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    generatedAt: new Date().toISOString(),
    corpusDocs: ctx.docs.length,
    caseCount: results.length,
    metrics: {
      recallAt5: round(average(recallAt5)),
      recallAt10: round(average(recallAt10)),
      ndcgAt10: round(average(ndcgAt10)),
      mrr: round(average(mrr)),
    },
    latencies: {
      total: summarizeLatency(totalMs),
      byStage: {
        lang: summarizeLatency(langMs),
        expansion: summarizeLatency(expansionMs),
        bm25: summarizeLatency(bm25Ms),
        vector: summarizeLatency(vectorMs),
        fusion: summarizeLatency(fusionMs),
        rerank: summarizeLatency(rerankMs),
        assembly: summarizeLatency(assemblyMs),
      },
    },
    cases: results,
  };
}
