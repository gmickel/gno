// node:fs/promises for temporary fixture materialization and cleanup.
import { mkdtemp, rm } from "node:fs/promises";
// node:os for portable temporary directories.
import { tmpdir } from "node:os";
// node:path for fixture path handling.
import { dirname, join, relative } from "node:path";
// node:url for ESM-safe repo paths.
import { fileURLToPath } from "node:url";

import type { ChunkOutput, ChunkParams } from "../../src/ingestion/types";

import { MarkdownChunker } from "../../src/ingestion/chunker";
import { chunkWithTreeSitterFallback } from "./chunker";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CHUNK_PARAMS,
  TREE_SITTER_GRAMMAR_PACKAGE,
  WEB_TREE_SITTER_PACKAGE,
  type AstChunkingBenchmarkSummary,
  type ChunkingMode,
  type CodeEmbeddingBenchmarkCase,
  type CodeEmbeddingFixture,
  type CorpusDoc,
  type MetricSummary,
  type ModeSummary,
  type RankedChunk,
  type SourceFixtureFile,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "../..");
export const FIXTURE_ROOT = join(
  REPO_ROOT,
  "evals/fixtures/code-embedding-benchmark"
);

const IDENTIFIER_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g;
const NON_WORD = /[^a-z0-9_]+/g;
const heuristicChunker = new MarkdownChunker();

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function nowMs(): number {
  return performance.now();
}

function tokenize(text: string): string[] {
  return text
    .replace(IDENTIFIER_BOUNDARY, " ")
    .toLowerCase()
    .split(NON_WORD)
    .filter((token) => token.length > 1);
}

function rankDocs(query: string, docs: Map<string, ChunkOutput[]>): string[] {
  const start = nowMs();
  const queryTerms = tokenize(query);
  const queryTermSet = new Set(queryTerms);
  const ranked: RankedChunk[] = [];

  for (const [docid, chunks] of docs) {
    for (const chunk of chunks) {
      const chunkTerms = tokenize(chunk.text);
      const chunkTermSet = new Set(chunkTerms);
      let exact = 0;
      let density = 0;
      for (const term of queryTermSet) {
        if (chunkTermSet.has(term)) {
          exact += 1;
        }
      }
      for (const term of queryTerms) {
        density += chunkTerms.filter((candidate) => candidate === term).length;
      }
      if (exact > 0 || density > 0) {
        ranked.push({
          docid,
          chunk,
          score:
            exact * 10 + density / Math.max(1, Math.sqrt(chunkTerms.length)),
        });
      }
    }
  }

  const sorted = ranked.sort((a, b) => b.score - a.score);
  const docsByBestChunk = [...new Set(sorted.map((item) => item.docid))];
  rankDocs.lastLatencyMs = round(nowMs() - start, 2);
  return docsByBestChunk;
}
rankDocs.lastLatencyMs = 0;

function summarizeMetrics(values: MetricSummary[]): MetricSummary {
  if (values.length === 0) {
    return { recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0 };
  }
  const avg = (get: (value: MetricSummary) => number) =>
    values.reduce((sum, item) => sum + get(item), 0) / values.length;
  return {
    recallAt5: round(avg((item) => item.recallAt5)),
    recallAt10: round(avg((item) => item.recallAt10)),
    ndcgAt10: round(avg((item) => item.ndcgAt10)),
    mrr: round(avg((item) => item.mrr)),
  };
}

function computeRecall(
  output: string[],
  expected: string[],
  k: number
): number {
  if (expected.length === 0) {
    return 1;
  }
  const topK = output.slice(0, k);
  const hits = expected.filter((docid) => topK.includes(docid)).length;
  return hits / expected.length;
}

function computeNdcg(
  output: string[],
  judgments: Array<{ docid: string; relevance: number }>,
  k: number
): number {
  if (judgments.length === 0) {
    return 1;
  }
  const relevanceMap = new Map(
    judgments.map((item) => [item.docid, item.relevance])
  );
  const dcg = output.slice(0, k).reduce((sum, docid, index) => {
    const relevance = relevanceMap.get(docid) ?? 0;
    return sum + (2 ** relevance - 1) / Math.log2(index + 2);
  }, 0);
  const idcg = [...judgments]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k)
    .reduce(
      (sum, item, index) =>
        sum + (2 ** item.relevance - 1) / Math.log2(index + 2),
      0
    );
  return idcg > 0 ? dcg / idcg : 1;
}

function computeMrr(output: string[], expected: string[]): number {
  if (expected.length === 0) {
    return 1;
  }
  const expectedSet = new Set(expected);
  for (const [index, docid] of output.entries()) {
    if (expectedSet.has(docid)) {
      return 1 / (index + 1);
    }
  }
  return 0;
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

async function loadFixture(id: string): Promise<CodeEmbeddingFixture> {
  const fixtures = (await Bun.file(
    join(FIXTURE_ROOT, "fixtures.json")
  ).json()) as CodeEmbeddingFixture[];
  const fixture = fixtures.find((item) => item.id === id);
  if (!fixture) {
    throw new Error(`Unknown fixture: ${id}`);
  }
  return fixture;
}

async function materializeCorpus(
  fixture: CodeEmbeddingFixture,
  tempDir: string
): Promise<string> {
  if (!fixture.sourceManifestPath) {
    return join(REPO_ROOT, fixture.corpusDir);
  }

  const manifest = (await Bun.file(
    join(REPO_ROOT, fixture.sourceManifestPath)
  ).json()) as SourceFixtureFile[];
  const corpusDir = join(tempDir, fixture.id);
  for (const entry of manifest) {
    const sourcePath = join(entry.repoPath, entry.relativePath);
    const sourceFile = Bun.file(sourcePath);
    if (!(await sourceFile.exists())) {
      throw new Error(`Missing source fixture file: ${sourcePath}`);
    }
    await Bun.write(join(corpusDir, entry.id, entry.relativePath), sourceFile);
  }
  return corpusDir;
}

async function loadCorpusDocs(
  corpusDir: string,
  include: string[]
): Promise<CorpusDoc[]> {
  const docs: CorpusDoc[] = [];
  for (const ext of include) {
    const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
    const glob = new Bun.Glob(`**/*.${normalized}`);
    for await (const match of glob.scan({ cwd: corpusDir })) {
      const absPath = join(corpusDir, match);
      docs.push({
        relPath: match,
        absPath,
        text: await Bun.file(absPath).text(),
      });
    }
  }
  return docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function chunkCorpus(
  docs: CorpusDoc[],
  mode: ChunkingMode,
  params: ChunkParams
): Promise<{ chunks: Map<string, ChunkOutput[]>; summary: ModeSummary }> {
  const chunks = new Map<string, ChunkOutput[]>();
  let parseMs = 0;
  let chunkMs = 0;
  let fallbackDocs = 0;
  let parseErrorDocs = 0;
  let unsupportedDocs = 0;
  let oversizedChunks = 0;
  let maxChunkChars = 0;

  for (const doc of docs) {
    const result =
      mode === "ast"
        ? await chunkWithTreeSitterFallback(doc.text, doc.absPath, params)
        : (() => {
            const chunkStart = nowMs();
            const chunks = heuristicChunker.chunk(
              doc.text,
              params,
              undefined,
              doc.absPath
            );
            return {
              chunks,
              stats: {
                usedAst: false,
                unsupported: false,
                parseError: false,
                parseMs: 0,
                chunkMs: round(nowMs() - chunkStart, 2),
              },
            };
          })();
    parseMs += result.stats.parseMs;
    chunkMs += result.stats.chunkMs;
    if (mode === "ast" && !result.stats.usedAst) {
      fallbackDocs += 1;
    }
    if (result.stats.parseError) {
      parseErrorDocs += 1;
    }
    if (result.stats.unsupported) {
      unsupportedDocs += 1;
    }
    for (const chunk of result.chunks) {
      maxChunkChars = Math.max(maxChunkChars, chunk.text.length);
      if (
        chunk.text.length >
        (params.maxTokens ?? 220) * CHARS_PER_TOKEN * 1.35
      ) {
        oversizedChunks += 1;
      }
    }
    chunks.set(doc.relPath, result.chunks);
  }

  const chunkCount = [...chunks.values()].reduce(
    (sum, item) => sum + item.length,
    0
  );
  return {
    chunks,
    summary: {
      metrics: { recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0 },
      latency: {
        parseMs: round(parseMs, 2),
        chunkMs: round(chunkMs, 2),
        rankMs: 0,
      },
      corpus: {
        docCount: docs.length,
        chunkCount,
        fallbackDocs,
        parseErrorDocs,
        unsupportedDocs,
        oversizedChunks,
        maxChunkChars,
      },
    },
  };
}

function decide(
  summary: Record<ChunkingMode, ModeSummary>
): AstChunkingBenchmarkSummary["decision"] {
  const ast = summary.ast;
  const heuristic = summary.heuristic;
  const astQualityDelta = ast.metrics.ndcgAt10 - heuristic.metrics.ndcgAt10;
  const astCostMultiplier =
    heuristic.latency.chunkMs > 0
      ? (ast.latency.parseMs + ast.latency.chunkMs) / heuristic.latency.chunkMs
      : Infinity;

  if (
    astQualityDelta >= 0.03 &&
    ast.corpus.parseErrorDocs === 0 &&
    astCostMultiplier <= 4
  ) {
    return {
      recommendation: "experimental",
      rationale: [
        `AST lexical nDCG@10 improved by ${round(astQualityDelta, 4)}.`,
        `AST parse+chunk cost was ${round(astCostMultiplier, 2)}x heuristic on this fixture.`,
        "Keep behind an internal flag until embedding benchmark and package impact are validated.",
      ],
    };
  }

  return {
    recommendation: "reject",
    rationale: [
      `AST lexical nDCG@10 delta was ${round(astQualityDelta, 4)}.`,
      `AST parse+chunk cost was ${Number.isFinite(astCostMultiplier) ? `${round(astCostMultiplier, 2)}x` : "not comparable"} heuristic.`,
      "Do not ship production AST chunking until it shows durable retrieval gains on code embedding fixtures.",
    ],
  };
}

export async function runAstChunkingBenchmark(options?: {
  fixture?: string;
  params?: ChunkParams;
}): Promise<AstChunkingBenchmarkSummary> {
  const fixture = await loadFixture(options?.fixture ?? "canonical");
  const tempDir = await mkdtemp(join(tmpdir(), "gno-ast-chunking-"));
  try {
    const corpusDir = await materializeCorpus(fixture, tempDir);
    const docs = await loadCorpusDocs(corpusDir, fixture.include);
    const cases = (await Bun.file(
      join(REPO_ROOT, fixture.queriesPath)
    ).json()) as CodeEmbeddingBenchmarkCase[];
    const params = options?.params ?? DEFAULT_CHUNK_PARAMS;

    const heuristic = await chunkCorpus(docs, "heuristic", params);
    const ast = await chunkCorpus(docs, "ast", params);
    const heuristicMetrics: MetricSummary[] = [];
    const astMetrics: MetricSummary[] = [];
    const caseRows = [];

    for (const testCase of cases) {
      const heuristicTopDocs = rankDocs(testCase.query, heuristic.chunks);
      heuristic.summary.latency.rankMs += rankDocs.lastLatencyMs;
      const astTopDocs = rankDocs(testCase.query, ast.chunks);
      ast.summary.latency.rankMs += rankDocs.lastLatencyMs;
      const hMetrics = computeMetrics(heuristicTopDocs, testCase);
      const aMetrics = computeMetrics(astTopDocs, testCase);
      heuristicMetrics.push(hMetrics);
      astMetrics.push(aMetrics);
      caseRows.push({
        id: testCase.id,
        query: testCase.query,
        relevantDocs: testCase.relevantDocs,
        heuristicTopDocs: heuristicTopDocs.slice(0, 10),
        astTopDocs: astTopDocs.slice(0, 10),
        heuristicMetrics: hMetrics,
        astMetrics: aMetrics,
      });
    }

    heuristic.summary.metrics = summarizeMetrics(heuristicMetrics);
    ast.summary.metrics = summarizeMetrics(astMetrics);
    heuristic.summary.latency.rankMs = round(
      heuristic.summary.latency.rankMs,
      2
    );
    ast.summary.latency.rankMs = round(ast.summary.latency.rankMs, 2);

    const modes = { heuristic: heuristic.summary, ast: ast.summary };
    return {
      generatedAt: new Date().toISOString(),
      fixture: {
        id: fixture.id,
        label: fixture.label,
        corpusDir: relative(REPO_ROOT, corpusDir),
        queryCount: cases.length,
      },
      packageImpact: {
        webTreeSitter: WEB_TREE_SITTER_PACKAGE,
        grammarPackage: TREE_SITTER_GRAMMAR_PACKAGE,
        grammarPackageUnpackedMb: 22.1,
        notes: [
          "Experiment uses dev-only WASM grammars for TS, TSX, JS, JSX, Python, Go, and Rust.",
          "Production package contents are unchanged unless AST chunking is promoted later.",
          "Unsupported languages such as Swift/C fall back to the current heuristic chunker.",
        ],
      },
      modes,
      cases: caseRows,
      decision: decide(modes),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function toAstChunkingMarkdown(
  summary: AstChunkingBenchmarkSummary
): string {
  const caseRows = summary.cases
    .map(
      (item) =>
        `| ${item.id} | ${item.heuristicMetrics.ndcgAt10.toFixed(3)} | ${item.astMetrics.ndcgAt10.toFixed(3)} | ${item.relevantDocs.join(", ")} |`
    )
    .join("\n");

  return `# AST Chunking Benchmark

Generated: ${summary.generatedAt}
Fixture: \`${summary.fixture.id}\` (${summary.fixture.queryCount} queries)

## Result

Recommendation: **${summary.decision.recommendation}**

${summary.decision.rationale.map((item) => `- ${item}`).join("\n")}

## Aggregate Metrics

| Mode | Recall@5 | Recall@10 | nDCG@10 | MRR | parse ms | chunk ms | rank ms | chunks | fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Heuristic | ${summary.modes.heuristic.metrics.recallAt5.toFixed(3)} | ${summary.modes.heuristic.metrics.recallAt10.toFixed(3)} | ${summary.modes.heuristic.metrics.ndcgAt10.toFixed(3)} | ${summary.modes.heuristic.metrics.mrr.toFixed(3)} | ${summary.modes.heuristic.latency.parseMs.toFixed(1)} | ${summary.modes.heuristic.latency.chunkMs.toFixed(1)} | ${summary.modes.heuristic.latency.rankMs.toFixed(1)} | ${summary.modes.heuristic.corpus.chunkCount} | ${summary.modes.heuristic.corpus.fallbackDocs} |
| AST | ${summary.modes.ast.metrics.recallAt5.toFixed(3)} | ${summary.modes.ast.metrics.recallAt10.toFixed(3)} | ${summary.modes.ast.metrics.ndcgAt10.toFixed(3)} | ${summary.modes.ast.metrics.mrr.toFixed(3)} | ${summary.modes.ast.latency.parseMs.toFixed(1)} | ${summary.modes.ast.latency.chunkMs.toFixed(1)} | ${summary.modes.ast.latency.rankMs.toFixed(1)} | ${summary.modes.ast.corpus.chunkCount} | ${summary.modes.ast.corpus.fallbackDocs} |

## Package Impact

- \`${summary.packageImpact.webTreeSitter}\`
- \`${summary.packageImpact.grammarPackage}\` (${summary.packageImpact.grammarPackageUnpackedMb} MB unpacked)

${summary.packageImpact.notes.map((item) => `- ${item}`).join("\n")}

## Cases

| Case | Heuristic nDCG@10 | AST nDCG@10 | Relevant docs |
| --- | ---: | ---: | --- |
${caseRows}
`;
}
