import type { QueryModeInput } from "../pipeline/types";
import type { RelevanceJudgment, RetrievalMetrics } from "./metrics";

export type BenchModeType = "bm25" | "vector" | "hybrid";

export interface BenchMode {
  name: string;
  type: BenchModeType;
  depth?: "thorough";
  noExpand?: boolean;
  noRerank?: boolean;
  candidateLimit?: number;
  limit?: number;
  queryModes?: QueryModeInput[];
}

export interface BenchCase {
  id: string;
  query: string;
  expected: string[];
  judgments: RelevanceJudgment[];
  collection?: string;
  topK?: number;
  queryModes?: QueryModeInput[];
}

export interface BenchFixture {
  version: 1;
  metadata?: {
    name?: string;
    description?: string;
    tags?: string[];
  };
  collection?: string;
  topK: number;
  candidateLimit?: number;
  modes: BenchMode[];
  queries: BenchCase[];
}

export interface BenchOptions {
  configPath?: string;
  indexName?: string;
  collection?: string;
  topK?: number;
  candidateLimit?: number;
  modes?: string[];
  json?: boolean;
}

export interface BenchCaseResult {
  id: string;
  query: string;
  topK: number;
  expected: string[];
  hits: string[];
  topDocs: string[];
  metrics: RetrievalMetrics;
  latencyMs: number;
  error?: string;
}

export interface BenchModeResult {
  name: string;
  type: BenchModeType;
  status: "ok" | "failed";
  queryCount: number;
  failures: number;
  metrics: RetrievalMetrics;
  latency: {
    p50Ms: number;
    p95Ms: number;
    meanMs: number;
  };
  cases: BenchCaseResult[];
}

export interface BenchOutput {
  fixture: {
    path: string;
    name?: string;
    version: 1;
    queryCount: number;
    topK: number;
  };
  generatedAt: string;
  modes: BenchModeResult[];
  meta: {
    indexName: string;
    collection?: string;
  };
}

export type BenchResult =
  | { success: true; data: BenchOutput }
  | { success: false; error: string; isValidation?: boolean };
