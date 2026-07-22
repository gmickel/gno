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

export const CJK_BENCH_LANGUAGES = ["zh", "ja", "ko"] as const;
export type CjkBenchLanguage = (typeof CJK_BENCH_LANGUAGES)[number];

export type CjkBenchCategory =
  | "exact-term"
  | "filename"
  | "identifier"
  | "mixed-script"
  | "normalization"
  | "punctuation"
  | "ranking"
  | "token-boundary";

export type CjkBenchLane =
  | "bm25"
  | "hybrid-no-models"
  | "substring-raw"
  | "substring-nfc";

export interface CjkBenchMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  zeroResultRate: number;
}

export interface CjkBenchLatency {
  coldQueryMs: number;
  warmQuery: {
    p50Ms: number;
    p95Ms: number;
    meanMs: number;
  };
}

export interface CjkBenchFailure {
  queryId: string;
  language: CjkBenchLanguage;
  category: CjkBenchCategory;
  reason: "below-rank-5" | "not-in-top-10" | "zero-result";
  query: string;
  expected: string[];
  topDocs: string[];
}

export interface CjkBenchCaseResult {
  queryId: string;
  language: CjkBenchLanguage;
  category: CjkBenchCategory;
  query: string;
  expected: string[];
  normalization?: {
    form: "NFC" | "NFKC";
    source: string;
    target: string;
  };
  topDocs: string[];
  metrics: Omit<CjkBenchMetrics, "zeroResultRate">;
  zeroResult: boolean;
  warmLatencyMs: number;
  error?: string;
}

export interface CjkBenchLanguageResult {
  language: CjkBenchLanguage;
  queryCount: number;
  metrics: CjkBenchMetrics;
  failures: CjkBenchFailure[];
}

export interface CjkBenchLaneResult {
  id: CjkBenchLane;
  description: string;
  config: Record<string, string | number | boolean | null>;
  queryCount: number;
  metrics: CjkBenchMetrics;
  latency: CjkBenchLatency;
  languages: CjkBenchLanguageResult[];
  cases: CjkBenchCaseResult[];
}

export interface CjkBenchOutput {
  schemaVersion: 1;
  generatedAt: string;
  benchmark: "gno-cjk-lexical-degradation";
  corpus: {
    fixtureVersion: number;
    documentCount: number;
    queryCount: number;
    languages: CjkBenchLanguage[];
    provenance: string;
    fingerprint: string;
  };
  runtime: {
    bun: string;
    platform: string;
    arch: string;
    sqlite: string;
  };
  index: {
    tokenizer: string;
    buildMs: number;
    bytes: number;
    pageCount: number;
    pageSize: number;
    vocabularyTerms: number;
    vocabularyDocuments: number;
    tokenOccurrences: number;
  };
  fingerprints: {
    config: string;
    runtime: string;
    tokenizer: string;
    result: string;
  };
  lanes: CjkBenchLaneResult[];
}
