import type { ChunkOutput } from "../../src/ingestion/types";

export const DEFAULT_CHUNK_PARAMS = { maxTokens: 220, overlapPercent: 0.08 };
export const CHARS_PER_TOKEN = 4;
export const TREE_SITTER_GRAMMAR_PACKAGE = "@vscode/tree-sitter-wasm@0.3.1";
export const WEB_TREE_SITTER_PACKAGE = "web-tree-sitter@0.26.8";

export type SupportedAstLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust";

export type ChunkingMode = "heuristic" | "ast";

export interface CodeEmbeddingBenchmarkCase {
  id: string;
  caseSet: "nl2code" | "identifier";
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

export interface CodeEmbeddingFixture {
  id: string;
  label: string;
  collection: string;
  corpusDir: string;
  queriesPath: string;
  include: string[];
  languages: string[];
  sourceManifestPath?: string;
}

export interface SourceFixtureFile {
  id: string;
  label: string;
  repoUrl: string;
  repoPath: string;
  commit: string;
  relativePath: string;
}

export interface CorpusDoc {
  relPath: string;
  absPath: string;
  text: string;
}

export interface MetricSummary {
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
}

export interface ModeSummary {
  metrics: MetricSummary;
  latency: {
    parseMs: number;
    chunkMs: number;
    rankMs: number;
  };
  corpus: {
    docCount: number;
    chunkCount: number;
    fallbackDocs: number;
    parseErrorDocs: number;
    unsupportedDocs: number;
    oversizedChunks: number;
    maxChunkChars: number;
  };
}

export interface AstChunkingBenchmarkSummary {
  generatedAt: string;
  fixture: {
    id: string;
    label: string;
    corpusDir: string;
    queryCount: number;
  };
  packageImpact: {
    webTreeSitter: string;
    grammarPackage: string;
    grammarPackageUnpackedMb: number;
    notes: string[];
  };
  modes: Record<ChunkingMode, ModeSummary>;
  cases: Array<{
    id: string;
    query: string;
    relevantDocs: string[];
    heuristicTopDocs: string[];
    astTopDocs: string[];
    heuristicMetrics: MetricSummary;
    astMetrics: MetricSummary;
  }>;
  decision: {
    recommendation: "ship" | "experimental" | "reject";
    rationale: string[];
  };
}

export interface AstChunkingStats {
  usedAst: boolean;
  parseError: boolean;
  unsupported: boolean;
  parseMs: number;
  chunkMs: number;
}

export interface ChunkingResult {
  chunks: ChunkOutput[];
  stats: AstChunkingStats;
}

export interface RankedChunk {
  docid: string;
  score: number;
  chunk: ChunkOutput;
}
