import type { Database } from "bun:sqlite";

// node:fs/promises for model file metadata and corpus reads.
import { readFile, stat } from "node:fs/promises";
// node:os for host memory capacity in benchmark metadata.
import { totalmem } from "node:os";
// node:path for cross-platform fixture path joins.
import { dirname, join } from "node:path";
// node:url for ESM-safe fixture directory resolution.
import { fileURLToPath } from "node:url";

import type { Config } from "../../src/config/types";
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../src/llm/types";
import type { ExplainLine } from "../../src/pipeline/types";
import type { SearchResult } from "../../src/pipeline/types";
import type { VectorIndexPort, VectorRow } from "../../src/store/vector/types";

import { createDefaultConfig } from "../../src/config";
import { DEFAULT_MODEL_PRESETS } from "../../src/config/types";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import {
  processAnswerResult,
  generateGroundedAnswer,
} from "../../src/pipeline/answer";
import { formatDocForEmbedding } from "../../src/pipeline/contextual";
import {
  buildExpansionPrompt,
  parseExpansionOutput,
} from "../../src/pipeline/expansion";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { createVectorIndexPort } from "../../src/store/vector";
import { computeMrr, computeNdcg, computeRecall } from "../scorers/ir-metrics";
import {
  ANSWER_SMOKE_CASES,
  RETRIEVAL_CANDIDATES,
  type CandidateMatrixEntry,
  EXPANSION_SMOKE_CASES,
  type RetrievalBenchmarkCase,
  RETRIEVAL_BENCHMARK_CASES,
} from "./retrieval-candidate-matrix";
import { getSharedEvalDb } from "./setup-db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "../fixtures/corpus");
const POLICY = { offline: false, allowDownload: true } as const;
const EMBED_BATCH_SIZE = 16;
const THINK_TAG_PATTERN = /<\/?think>/i;
const QUERY_TOKEN_PATTERN =
  /"([^"]+)"|-(?:"([^"]+)"|([^\s]+))|[A-Za-z0-9][A-Za-z0-9.+#:_/-]*/g;
interface ChunkRow {
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
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

interface ExpansionSmokeResult {
  id: string;
  label: string;
  query: string;
  rawOutput: string | null;
  parseOk: boolean;
  cleanJson: boolean;
  thinkLeak: boolean;
  entityLoss: boolean;
  negationDrift: boolean;
  latencyMs: number;
  lexicalQueries: string[];
  vectorQueries: string[];
  hyde: string | null;
}

interface RetrievalCaseResult {
  id: string;
  caseSet: RetrievalBenchmarkCase["caseSet"];
  category: string;
  query: string;
  topDocs: string[];
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  timings: StageTimings;
}

interface AnswerSmokeResult {
  id: string;
  question: string;
  latencyMs: number;
  topicHitRate: number;
  hasCitations: boolean;
  validCitationRate: number;
  citedSources: string[];
  answer: string;
}

interface CandidateScore {
  metric: MetricSummary;
  latency: LatencySummary;
}

export interface CandidateBenchmarkResult {
  candidate: CandidateMatrixEntry;
  ok: boolean;
  error?: string;
  resolvedModelPath?: string;
  modelFileBytes?: number;
  vectorAvailable: boolean;
  load: {
    firstResponseMs: number;
    rssDeltaBytes: number;
    peakRssBytes: number;
  };
  expansion: {
    schemaSuccessRate: number;
    cleanJsonRate: number;
    thinkLeakRate: number;
    entityLossRate: number;
    negationDriftRate: number;
    averageLatencyMs: number;
    averageRawChars: number;
    averageLexicalQueries: number;
    averageVectorQueries: number;
    averageHydeChars: number;
    smoke: ExpansionSmokeResult[];
  };
  retrieval: {
    caseCount: number;
    metrics: MetricSummary;
    bySet: Record<string, CandidateScore>;
    latencies: {
      total: LatencySummary;
      byStage: Record<string, LatencySummary>;
    };
    cases: RetrievalCaseResult[];
  };
  answerSmoke: {
    caseCount: number;
    topicHitRate: number;
    citationRate: number;
    validCitationRate: number;
    latency: LatencySummary;
    cases: AnswerSmokeResult[];
  };
}

export interface RetrievalCandidateBenchmarkSummary {
  generatedAt: string;
  host: {
    platform: string;
    arch: string;
    bunVersion: string;
    totalMemoryBytes: number;
  };
  runtime: {
    embedModel: string;
    rerankModel: string;
    vectorAvailable: boolean;
    retrievalCaseCount: number;
    answerSmokeCaseCount: number;
  };
  candidates: CandidateBenchmarkResult[];
  recommendation: {
    expansionBaselineId: string;
    bestRetrievalId: string | null;
    bestAnswerSmokeId: string | null;
  };
}

interface BenchmarkRuntime {
  config: Config;
  llm: LlmAdapter;
  embedPort: EmbeddingPort;
  rerankPort: RerankPort;
  vectorIndex: VectorIndexPort | null;
  vectorAvailable: boolean;
  store: Awaited<ReturnType<typeof getSharedEvalDb>>["adapter"];
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

function summarizeMetrics(cases: RetrievalCaseResult[]): MetricSummary {
  const average = (values: number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    recallAt5: round(average(cases.map((item) => item.recallAt5))),
    recallAt10: round(average(cases.map((item) => item.recallAt10))),
    ndcgAt10: round(average(cases.map((item) => item.ndcgAt10))),
    mrr: round(average(cases.map((item) => item.mrr))),
  };
}

function summarizeBySet(
  cases: RetrievalCaseResult[]
): Record<string, CandidateScore> {
  const output: Record<string, CandidateScore> = {};
  for (const caseSet of ["baseline", "multilingual", "adversarial", "ask"]) {
    const subset = cases.filter((item) => item.caseSet === caseSet);
    output[caseSet] = {
      metric: summarizeMetrics(subset),
      latency: summarizeLatency(subset.map((item) => item.timings.totalMs)),
    };
  }
  return output;
}

function parseTimings(
  lines: ExplainLine[] | undefined,
  fallback: number
): StageTimings {
  const timings: StageTimings = {
    langMs: 0,
    expansionMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
    fusionMs: 0,
    rerankMs: 0,
    assemblyMs: 0,
    totalMs: fallback,
  };
  const timingLine = lines?.find((line) => line.stage === "timing");
  if (!timingLine) {
    return timings;
  }
  for (const match of timingLine.message.matchAll(
    /([a-z]+)=([0-9]+(?:\.[0-9]+)?)ms/g
  )) {
    const key = match[1];
    const value = Number(match[2]);
    if (!(key && Number.isFinite(value))) {
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

function extractQuerySignals(query: string): {
  criticalEntities: string[];
  negations: string[];
} {
  const criticalEntities = new Set<string>();
  const negations = new Set<string>();
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const phrase = match[1]?.trim();
    const negatedPhrase = match[2]?.trim();
    const negatedToken = match[3]?.trim();
    const token = match[0]?.trim();
    if (!token) {
      continue;
    }
    if (token.startsWith("-")) {
      negations.add(token);
      continue;
    }
    if (
      phrase ||
      /[A-Z]/.test(token) ||
      /[+#.:/]/.test(token) ||
      /[A-Za-z]\d|\d[A-Za-z]/.test(token)
    ) {
      criticalEntities.add(phrase ?? token);
    }
    if (negatedPhrase || negatedToken) {
      negations.add(token);
    }
  }
  return {
    criticalEntities: [...criticalEntities],
    negations: [...negations],
  };
}

function normalizeText(text: string): string {
  return text.toLowerCase();
}

function dedupeDocids(docids: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const docid of docids) {
    if (seen.has(docid)) {
      continue;
    }
    seen.add(docid);
    deduped.push(docid);
  }
  return deduped;
}

function detectEntityLoss(query: string, joinedOutput: string): boolean {
  const signals = extractQuerySignals(query);
  const haystack = normalizeText(joinedOutput);
  return signals.criticalEntities.some(
    (entity) => !haystack.includes(normalizeText(entity))
  );
}

function detectNegationDrift(query: string, lexicalQueries: string[]): boolean {
  const signals = extractQuerySignals(query);
  if (signals.negations.length === 0) {
    return false;
  }
  const haystack = normalizeText(lexicalQueries.join("\n"));
  return signals.negations.some(
    (negation) => !haystack.includes(normalizeText(negation))
  );
}

async function loadMockSources(mockPaths: string[]): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const relPath of mockPaths) {
    const fullPath = join(CORPUS_DIR, relPath);
    const content = await readFile(fullPath, "utf8");
    results.push({
      docid: relPath,
      score: 1,
      uri: `file://${fullPath}`,
      title: relPath.split("/").pop()?.replace(".md", "") ?? relPath,
      snippet: content,
      source: {
        relPath,
        mime: "text/markdown",
        ext: ".md",
      },
    });
  }
  return results;
}

async function getChunkRows(db: Database): Promise<ChunkRow[]> {
  return db
    .prepare(
      `SELECT c.mirror_hash as mirrorHash, c.seq as seq, c.text as text, d.title as title
       FROM content_chunks c
       JOIN documents d ON d.mirror_hash = c.mirror_hash
       WHERE d.active = 1
       ORDER BY c.mirror_hash, c.seq`
    )
    .all() as ChunkRow[];
}

async function ensureVectorIndex(runtime: {
  llm: LlmAdapter;
  config: Config;
  store: Awaited<ReturnType<typeof getSharedEvalDb>>["adapter"];
}): Promise<{
  embedPort: EmbeddingPort;
  rerankPort: RerankPort;
  vectorIndex: VectorIndexPort | null;
  vectorAvailable: boolean;
}> {
  const embedUri = DEFAULT_MODEL_PRESETS[0]?.embed;
  const rerankUri = DEFAULT_MODEL_PRESETS[0]?.rerank;
  if (!(embedUri && rerankUri)) {
    throw new Error("Default embed/rerank URIs missing");
  }

  const embedResult = await runtime.llm.createEmbeddingPort(embedUri, {
    policy: POLICY,
  });
  if (!embedResult.ok) {
    throw new Error(`Failed to load embed model: ${embedResult.error.message}`);
  }
  const embedPort = embedResult.value;
  const initResult = await embedPort.init();
  if (!initResult.ok) {
    throw new Error(`Failed to init embed model: ${initResult.error.message}`);
  }

  const rerankResult = await runtime.llm.createRerankPort(rerankUri, {
    policy: POLICY,
  });
  if (!rerankResult.ok) {
    throw new Error(
      `Failed to load rerank model: ${rerankResult.error.message}`
    );
  }
  const rerankPort = rerankResult.value;

  const vectorResult = await createVectorIndexPort(runtime.store.getRawDb(), {
    model: embedUri,
    dimensions: embedPort.dimensions(),
  });
  if (!vectorResult.ok) {
    throw new Error(
      `Failed to create vector index: ${vectorResult.error.message}`
    );
  }
  const vectorIndex = vectorResult.value;

  if (!vectorIndex.searchAvailable) {
    return { embedPort, rerankPort, vectorIndex: null, vectorAvailable: false };
  }

  const existingCount = runtime.store
    .getRawDb()
    .prepare("SELECT COUNT(*) as count FROM content_vectors WHERE model = ?")
    .get(embedUri) as { count: number };

  if (existingCount.count === 0) {
    const rows = await getChunkRows(runtime.store.getRawDb());
    for (let index = 0; index < rows.length; index += EMBED_BATCH_SIZE) {
      const batch = rows.slice(index, index + EMBED_BATCH_SIZE);
      const embedBatchResult = await embedPort.embedBatch(
        batch.map((row) =>
          formatDocForEmbedding(row.text, row.title ?? undefined)
        )
      );
      if (!embedBatchResult.ok) {
        throw new Error(
          `Failed to embed eval corpus: ${embedBatchResult.error.message}`
        );
      }
      const vectorRows: VectorRow[] = batch.map((row, batchIndex) => ({
        mirrorHash: row.mirrorHash,
        seq: row.seq,
        model: embedUri,
        embedding: new Float32Array(embedBatchResult.value[batchIndex] ?? []),
      }));
      const upsertResult = await vectorIndex.upsertVectors(vectorRows);
      if (!upsertResult.ok) {
        throw new Error(
          `Failed to store eval vectors: ${upsertResult.error.message}`
        );
      }
    }
    if (vectorIndex.vecDirty) {
      await vectorIndex.syncVecIndex();
      vectorIndex.vecDirty = false;
    }
  }

  return { embedPort, rerankPort, vectorIndex, vectorAvailable: true };
}

async function resolveCandidateFile(
  llm: LlmAdapter,
  uri: string
): Promise<{
  path?: string;
  size?: number;
}> {
  const resolved = await llm.getCache().resolve(uri, "gen");
  if (!resolved.ok) {
    return {};
  }
  try {
    const file = await stat(resolved.value);
    return { path: resolved.value, size: file.size };
  } catch {
    return { path: resolved.value };
  }
}

async function benchmarkExpansionSmoke(
  candidate: CandidateMatrixEntry,
  genPort: GenerationPort,
  initialRss: number
): Promise<{
  smoke: ExpansionSmokeResult[];
  firstResponseMs: number;
  rssDeltaBytes: number;
  peakRssBytes: number;
}> {
  const smoke: ExpansionSmokeResult[] = [];
  let firstResponseMs = 0;
  let rssDeltaBytes = 0;
  let peakRssBytes = initialRss;

  for (const [index, testCase] of EXPANSION_SMOKE_CASES.entries()) {
    const prompt = buildExpansionPrompt(testCase.query, {
      lang: testCase.lang,
      intent: testCase.intent,
    });
    const startedAt = performance.now();
    const result = await genPort.generate(prompt, {
      temperature: 0,
      seed: 42,
      maxTokens: 512,
      contextSize: 2_048,
    });
    const latencyMs = performance.now() - startedAt;
    const rss = process.memoryUsage().rss;
    peakRssBytes = Math.max(peakRssBytes, rss);
    if (index === 0) {
      firstResponseMs = latencyMs;
      rssDeltaBytes = Math.max(0, rss - initialRss);
    }

    const rawOutput = result.ok ? result.value : null;
    const parsed = rawOutput
      ? parseExpansionOutput(rawOutput, testCase.query)
      : null;
    const cleanJson = rawOutput ? rawOutput.trim().startsWith("{") : false;
    const joinedOutput = [
      ...(parsed?.lexicalQueries ?? []),
      ...(parsed?.vectorQueries ?? []),
      parsed?.hyde ?? "",
    ].join("\n");

    smoke.push({
      id: testCase.id,
      label: testCase.label,
      query: testCase.query,
      rawOutput,
      parseOk: parsed !== null,
      cleanJson,
      thinkLeak: rawOutput ? THINK_TAG_PATTERN.test(rawOutput) : false,
      entityLoss: parsed
        ? detectEntityLoss(testCase.query, joinedOutput)
        : true,
      negationDrift: parsed
        ? detectNegationDrift(testCase.query, parsed.lexicalQueries)
        : true,
      latencyMs: round(latencyMs, 2),
      lexicalQueries: parsed?.lexicalQueries ?? [],
      vectorQueries: parsed?.vectorQueries ?? [],
      hyde: parsed?.hyde ?? null,
    });
  }

  return { smoke, firstResponseMs, rssDeltaBytes, peakRssBytes };
}

async function benchmarkRetrieval(
  runtime: BenchmarkRuntime,
  genPort: GenerationPort
): Promise<CandidateBenchmarkResult["retrieval"]> {
  const cases: RetrievalCaseResult[] = [];

  for (const testCase of RETRIEVAL_BENCHMARK_CASES) {
    const startedAt = performance.now();
    const result = await searchHybrid(
      {
        store: runtime.store,
        config: runtime.config,
        vectorIndex: runtime.vectorIndex,
        embedPort: runtime.vectorIndex ? runtime.embedPort : null,
        genPort,
        rerankPort: runtime.rerankPort,
      },
      testCase.query,
      {
        collection: "eval",
        limit: 10,
        explain: true,
        queryModes: testCase.queryModes,
      }
    );

    const durationMs = performance.now() - startedAt;
    const docids = result.ok
      ? result.value.results.map((entry) => entry.source.relPath)
      : [];
    const rankedDocids = dedupeDocids(docids);
    const timings = result.ok
      ? parseTimings(result.value.meta.explain?.lines, durationMs)
      : parseTimings(undefined, durationMs);

    cases.push({
      id: testCase.id,
      caseSet: testCase.caseSet,
      category: testCase.category,
      query: testCase.query,
      topDocs: rankedDocids.slice(0, 5),
      recallAt5: round(computeRecall(rankedDocids, testCase.relevantDocs, 5)),
      recallAt10: round(computeRecall(rankedDocids, testCase.relevantDocs, 10)),
      ndcgAt10: round(computeNdcg(rankedDocids, testCase.judgments, 10)),
      mrr: round(computeMrr(rankedDocids, testCase.relevantDocs)),
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

  const stageNames: Array<keyof StageTimings> = [
    "langMs",
    "expansionMs",
    "bm25Ms",
    "vectorMs",
    "fusionMs",
    "rerankMs",
    "assemblyMs",
    "totalMs",
  ];
  const byStage = Object.fromEntries(
    stageNames.map((name) => [
      name.replace(/Ms$/, ""),
      summarizeLatency(cases.map((item) => item.timings[name])),
    ])
  );

  return {
    caseCount: cases.length,
    metrics: summarizeMetrics(cases),
    bySet: summarizeBySet(cases),
    latencies: {
      total: summarizeLatency(cases.map((item) => item.timings.totalMs)),
      byStage,
    },
    cases,
  };
}

async function benchmarkAnswerSmoke(
  genPort: GenerationPort
): Promise<CandidateBenchmarkResult["answerSmoke"]> {
  const cases: AnswerSmokeResult[] = [];

  for (const testCase of ANSWER_SMOKE_CASES) {
    const sources = await loadMockSources(testCase.mockSources);
    const startedAt = performance.now();
    const rawResult = await generateGroundedAnswer(
      { genPort, store: null },
      testCase.question,
      sources,
      512
    );
    const latencyMs = performance.now() - startedAt;
    const processed = rawResult ? processAnswerResult(rawResult) : null;
    const citedSources =
      processed?.citations.map((citation) => citation.docid) ?? [];
    const topicHits = testCase.expectedTopics.filter((topic) =>
      normalizeText(processed?.answer ?? "").includes(normalizeText(topic))
    );

    cases.push({
      id: testCase.id,
      question: testCase.question,
      latencyMs: round(latencyMs, 2),
      topicHitRate: round(topicHits.length / testCase.expectedTopics.length),
      hasCitations: citedSources.length > 0,
      validCitationRate:
        citedSources.length === 0
          ? 0
          : round(
              citedSources.filter((source) =>
                testCase.mockSources.includes(source)
              ).length / citedSources.length
            ),
      citedSources,
      answer: processed?.answer ?? "",
    });
  }

  return {
    caseCount: cases.length,
    topicHitRate: round(
      cases.reduce((sum, item) => sum + item.topicHitRate, 0) / cases.length
    ),
    citationRate: round(
      cases.filter((item) => item.hasCitations).length / cases.length
    ),
    validCitationRate: round(
      cases.reduce((sum, item) => sum + item.validCitationRate, 0) /
        cases.length
    ),
    latency: summarizeLatency(cases.map((item) => item.latencyMs)),
    cases,
  };
}

async function benchmarkCandidate(
  runtime: BenchmarkRuntime,
  candidate: CandidateMatrixEntry
): Promise<CandidateBenchmarkResult> {
  const genResult = await runtime.llm.createGenerationPort(candidate.uri, {
    policy: POLICY,
  });
  if (!genResult.ok) {
    return {
      candidate,
      ok: false,
      error: genResult.error.message,
      vectorAvailable: runtime.vectorAvailable,
      load: {
        firstResponseMs: 0,
        rssDeltaBytes: 0,
        peakRssBytes: process.memoryUsage().rss,
      },
      expansion: {
        schemaSuccessRate: 0,
        cleanJsonRate: 0,
        thinkLeakRate: 0,
        entityLossRate: 0,
        negationDriftRate: 0,
        averageLatencyMs: 0,
        averageRawChars: 0,
        averageLexicalQueries: 0,
        averageVectorQueries: 0,
        averageHydeChars: 0,
        smoke: [],
      },
      retrieval: {
        caseCount: 0,
        metrics: { recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0 },
        bySet: {},
        latencies: { total: { p50Ms: 0, p95Ms: 0, meanMs: 0 }, byStage: {} },
        cases: [],
      },
      answerSmoke: {
        caseCount: 0,
        topicHitRate: 0,
        citationRate: 0,
        validCitationRate: 0,
        latency: { p50Ms: 0, p95Ms: 0, meanMs: 0 },
        cases: [],
      },
    };
  }

  const genPort = genResult.value;
  const initialRss = process.memoryUsage().rss;
  try {
    const modelFile = await resolveCandidateFile(runtime.llm, candidate.uri);
    const expansionSmoke = await benchmarkExpansionSmoke(
      candidate,
      genPort,
      initialRss
    );
    const retrieval = await benchmarkRetrieval(runtime, genPort);
    const answerSmoke = await benchmarkAnswerSmoke(genPort);

    return {
      candidate,
      ok: true,
      resolvedModelPath: modelFile.path,
      modelFileBytes: modelFile.size,
      vectorAvailable: runtime.vectorAvailable,
      load: {
        firstResponseMs: round(expansionSmoke.firstResponseMs, 2),
        rssDeltaBytes: expansionSmoke.rssDeltaBytes,
        peakRssBytes: expansionSmoke.peakRssBytes,
      },
      expansion: {
        schemaSuccessRate: round(
          expansionSmoke.smoke.filter((item) => item.parseOk).length /
            expansionSmoke.smoke.length
        ),
        cleanJsonRate: round(
          expansionSmoke.smoke.filter((item) => item.cleanJson).length /
            expansionSmoke.smoke.length
        ),
        thinkLeakRate: round(
          expansionSmoke.smoke.filter((item) => item.thinkLeak).length /
            expansionSmoke.smoke.length
        ),
        entityLossRate: round(
          expansionSmoke.smoke.filter((item) => item.entityLoss).length /
            expansionSmoke.smoke.length
        ),
        negationDriftRate: round(
          expansionSmoke.smoke.filter((item) => item.negationDrift).length /
            expansionSmoke.smoke.length
        ),
        averageLatencyMs: round(
          expansionSmoke.smoke.reduce((sum, item) => sum + item.latencyMs, 0) /
            expansionSmoke.smoke.length,
          2
        ),
        averageRawChars: round(
          expansionSmoke.smoke.reduce(
            (sum, item) => sum + (item.rawOutput?.length ?? 0),
            0
          ) / expansionSmoke.smoke.length,
          2
        ),
        averageLexicalQueries: round(
          expansionSmoke.smoke.reduce(
            (sum, item) => sum + item.lexicalQueries.length,
            0
          ) / expansionSmoke.smoke.length,
          2
        ),
        averageVectorQueries: round(
          expansionSmoke.smoke.reduce(
            (sum, item) => sum + item.vectorQueries.length,
            0
          ) / expansionSmoke.smoke.length,
          2
        ),
        averageHydeChars: round(
          expansionSmoke.smoke.reduce(
            (sum, item) => sum + (item.hyde?.length ?? 0),
            0
          ) / expansionSmoke.smoke.length,
          2
        ),
        smoke: expansionSmoke.smoke,
      },
      retrieval,
      answerSmoke,
    };
  } catch (error) {
    return {
      candidate,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      vectorAvailable: runtime.vectorAvailable,
      load: {
        firstResponseMs: 0,
        rssDeltaBytes: 0,
        peakRssBytes: process.memoryUsage().rss,
      },
      expansion: {
        schemaSuccessRate: 0,
        cleanJsonRate: 0,
        thinkLeakRate: 0,
        entityLossRate: 0,
        negationDriftRate: 0,
        averageLatencyMs: 0,
        averageRawChars: 0,
        averageLexicalQueries: 0,
        averageVectorQueries: 0,
        averageHydeChars: 0,
        smoke: [],
      },
      retrieval: {
        caseCount: 0,
        metrics: { recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0 },
        bySet: {},
        latencies: { total: { p50Ms: 0, p95Ms: 0, meanMs: 0 }, byStage: {} },
        cases: [],
      },
      answerSmoke: {
        caseCount: 0,
        topicHitRate: 0,
        citationRate: 0,
        validCitationRate: 0,
        latency: { p50Ms: 0, p95Ms: 0, meanMs: 0 },
        cases: [],
      },
    };
  } finally {
    await genPort.dispose();
    await runtime.llm.getManager().dispose(candidate.uri);
  }
}

function pickBestCandidate(
  candidates: CandidateBenchmarkResult[],
  scorer: (candidate: CandidateBenchmarkResult) => number
): CandidateBenchmarkResult | null {
  const viable = candidates.filter((candidate) => candidate.ok);
  if (viable.length === 0) {
    return null;
  }
  return (
    [...viable].sort((left, right) => scorer(right) - scorer(left))[0] ?? null
  );
}

export async function runRetrievalCandidateBenchmark(
  selectedIds?: string[],
  candidatePool: CandidateMatrixEntry[] = RETRIEVAL_CANDIDATES
): Promise<RetrievalCandidateBenchmarkSummary> {
  const config = createDefaultConfig();
  const llm = new LlmAdapter(config);
  const ctx = await getSharedEvalDb();
  const runtimeBase = { config, llm, store: ctx.adapter };
  const shared = await ensureVectorIndex(runtimeBase);
  const runtime: BenchmarkRuntime = {
    ...runtimeBase,
    ...shared,
  };

  const selected = selectedIds?.length
    ? candidatePool.filter((candidate) => selectedIds.includes(candidate.id))
    : candidatePool;

  try {
    const candidates: CandidateBenchmarkResult[] = [];
    for (const candidate of selected) {
      candidates.push(await benchmarkCandidate(runtime, candidate));
    }

    const bestRetrieval = pickBestCandidate(candidates, (candidate) => {
      const metric = candidate.retrieval.metrics;
      const askRecall = candidate.retrieval.bySet.ask?.metric.recallAt5 ?? 0;
      const multilingual =
        candidate.retrieval.bySet.multilingual?.metric.ndcgAt10 ?? 0;
      return (
        metric.ndcgAt10 * 1_000 +
        askRecall * 200 +
        multilingual * 120 +
        metric.mrr * 80 -
        candidate.retrieval.latencies.total.p95Ms / 80 -
        candidate.expansion.entityLossRate * 40 -
        candidate.expansion.negationDriftRate * 20
      );
    });
    const bestAnswer = pickBestCandidate(candidates, (candidate) => {
      return (
        candidate.answerSmoke.topicHitRate * 100 +
        candidate.answerSmoke.validCitationRate * 25 -
        candidate.answerSmoke.latency.p95Ms / 150
      );
    });

    return {
      generatedAt: new Date().toISOString(),
      host: {
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        totalMemoryBytes: totalmem(),
      },
      runtime: {
        embedModel: DEFAULT_MODEL_PRESETS[0]?.embed ?? "",
        rerankModel: DEFAULT_MODEL_PRESETS[0]?.rerank ?? "",
        vectorAvailable: runtime.vectorAvailable,
        retrievalCaseCount: RETRIEVAL_BENCHMARK_CASES.length,
        answerSmokeCaseCount: ANSWER_SMOKE_CASES.length,
      },
      candidates,
      recommendation: {
        expansionBaselineId: "current-qwen3-1.7b-q4",
        bestRetrievalId: bestRetrieval?.candidate.id ?? null,
        bestAnswerSmokeId: bestAnswer?.candidate.id ?? null,
      },
    };
  } finally {
    await runtime.embedPort.dispose();
    await runtime.rerankPort.dispose();
    await runtime.llm.dispose();
  }
}
