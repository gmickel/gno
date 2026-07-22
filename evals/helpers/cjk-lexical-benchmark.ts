import { Database } from "bun:sqlite";
// node:fs/promises: temporary directory lifecycle has no Bun equivalent.
import { mkdtemp, rm } from "node:fs/promises";
// node:os: platform and temporary directory discovery have no Bun equivalent.
import { arch, platform, tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import type {
  CjkBenchCaseResult,
  CjkBenchCategory,
  CjkBenchLane,
  CjkBenchLaneResult,
  CjkBenchLanguage,
  CjkBenchOutput,
} from "../../src/bench/types";
import type { Collection, Config } from "../../src/config/types";

import {
  fingerprint,
  fingerprintStableResult,
} from "../../src/bench/cjk-fingerprint";
import {
  buildCjkCaseResult,
  summarizeCjkLanguage,
  summarizeCjkMetrics,
  summarizeLatency,
} from "../../src/bench/cjk-metrics";
import { CJK_BENCH_LANGUAGES } from "../../src/bench/types";
import { CONFIG_VERSION, DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { SyncService } from "../../src/ingestion/sync";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store";

const FIXTURE_ROOT = join(import.meta.dir, "../fixtures/cjk-lexical-benchmark");
const CORPUS_ROOT = join(FIXTURE_ROOT, "corpus");
const COLLECTION_NAME = "cjk-lexical-benchmark";

interface FixtureManifest {
  version: number;
  languages: CjkBenchLanguage[];
  provenanceReview: { method: string };
}

interface FixtureSource {
  id: string;
  language: CjkBenchLanguage;
  contentSha256: string;
}

interface NormalizationVariant {
  form: "NFC" | "NFKC";
  source: string;
  target: string;
}

interface FixtureQuery {
  id: string;
  language: CjkBenchLanguage;
  query: string;
  category: CjkBenchCategory;
  normalizationVariant?: NormalizationVariant;
  rankingVariant?: {
    relevantDiscriminator: string;
    sharedTerms: string[];
  };
}

interface FixtureJudgment {
  queryId: string;
  docid: string;
  relevance: number;
}

interface LoadedDocument extends FixtureSource {
  title: string;
  content: string;
}

interface CjkFixture {
  manifest: FixtureManifest;
  sources: FixtureSource[];
  queries: FixtureQuery[];
  judgments: FixtureJudgment[];
  documents: LoadedDocument[];
}

export interface RunCjkBenchmarkOptions {
  languages?: CjkBenchLanguage[];
  queryIds?: string[];
  generatedAt?: string;
}

const loadFixture = async (): Promise<CjkFixture> => {
  const [manifest, sources, queries, qrels] = await Promise.all([
    Bun.file(
      join(FIXTURE_ROOT, "manifest.json")
    ).json() as Promise<FixtureManifest>,
    Bun.file(join(FIXTURE_ROOT, "sources.json")).json() as Promise<
      FixtureSource[]
    >,
    Bun.file(join(FIXTURE_ROOT, "queries.json")).json() as Promise<
      FixtureQuery[]
    >,
    Bun.file(join(FIXTURE_ROOT, "qrels.json")).json() as Promise<{
      judgments: FixtureJudgment[];
    }>,
  ]);
  const documents = await Promise.all(
    sources.map(async (source) => {
      const content = await Bun.file(join(CORPUS_ROOT, source.id)).text();
      return {
        ...source,
        title: /^#\s+(.+)$/m.exec(content)?.[1] ?? source.id,
        content,
      };
    })
  );
  return { manifest, sources, queries, judgments: qrels.judgments, documents };
};

export const diagnosticSearch = (
  documents: LoadedDocument[],
  query: string,
  normalization: "raw" | "NFC"
): string[] => {
  const transform = (value: string): string =>
    (normalization === "NFC" ? value.normalize("NFC") : value).toLowerCase();
  const normalizedQuery = transform(query);
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
  return documents
    .map((document) => {
      const haystack = transform(`${document.title}\n${document.content}`);
      const matches = terms.filter((term) => haystack.includes(term)).length;
      return {
        id: document.id,
        matches,
        exactPhrase: haystack.includes(normalizedQuery),
      };
    })
    .filter((candidate) => candidate.matches === terms.length)
    .sort(
      (left, right) =>
        Number(right.exactPhrase) - Number(left.exactPhrase) ||
        right.matches - left.matches ||
        left.id.localeCompare(right.id)
    )
    .map((candidate) => candidate.id)
    .slice(0, 10);
};

const createLaneSearch = (
  lane: CjkBenchLane,
  store: SqliteAdapter,
  config: Config,
  documents: LoadedDocument[]
): ((query: FixtureQuery) => Promise<{ docs: string[]; error?: string }>) => {
  if (lane === "substring-raw" || lane === "substring-nfc") {
    return async (query) => ({
      docs: diagnosticSearch(
        documents,
        query.query,
        lane === "substring-nfc" ? "NFC" : "raw"
      ),
    });
  }
  if (lane === "bm25") {
    return async (query) => {
      const result = await searchBm25(store, query.query, {
        collection: COLLECTION_NAME,
        limit: 10,
      });
      return result.ok
        ? { docs: result.value.results.map((entry) => entry.source.relPath) }
        : { docs: [], error: result.error.message };
    };
  }
  return async (query) => {
    const result = await searchHybrid(
      {
        store,
        config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      query.query,
      {
        collection: COLLECTION_NAME,
        limit: 10,
        noExpand: true,
        noRerank: true,
      }
    );
    return result.ok
      ? { docs: result.value.results.map((entry) => entry.source.relPath) }
      : { docs: [], error: result.error.message };
  };
};

const LANE_DESCRIPTIONS: Record<CjkBenchLane, string> = {
  bm25: "Production BM25 through searchBm25",
  "hybrid-no-models":
    "Production hybrid pipeline with vector, expansion, and rerank disabled",
  "substring-raw":
    "Benchmark-only raw substring diagnostic over title and content",
  "substring-nfc":
    "Benchmark-only NFC substring diagnostic over title and content",
};

const laneConfig = (
  lane: CjkBenchLane
): Record<string, string | number | boolean | null> => ({
  collection: COLLECTION_NAME,
  limit: 10,
  tokenizer: DEFAULT_FTS_TOKENIZER,
  vector: false,
  expand: false,
  rerank: false,
  normalization:
    lane === "substring-nfc" ? "NFC" : lane === "substring-raw" ? "raw" : null,
  match:
    lane === "substring-nfc" || lane === "substring-raw"
      ? "all-query-terms-substring-with-exact-phrase-boost"
      : "production-fts",
});

const runLane = async (input: {
  lane: CjkBenchLane;
  queries: FixtureQuery[];
  judgments: FixtureJudgment[];
  store: SqliteAdapter;
  config: Config;
  documents: LoadedDocument[];
}): Promise<CjkBenchLaneResult> => {
  const search = createLaneSearch(
    input.lane,
    input.store,
    input.config,
    input.documents
  );
  const firstQuery = input.queries[0];
  const coldStarted = performance.now();
  if (firstQuery) {
    await search(firstQuery);
  }
  const coldQueryMs = performance.now() - coldStarted;

  for (const query of input.queries) {
    await search(query);
  }

  const cases: CjkBenchCaseResult[] = [];
  for (const query of input.queries) {
    const started = performance.now();
    const result = await search(query);
    const expectedJudgments = input.judgments.filter(
      (judgment) => judgment.queryId === query.id && judgment.relevance > 0
    );
    const item = buildCjkCaseResult({
      queryId: query.id,
      language: query.language,
      category: query.category,
      query: query.query,
      expected: expectedJudgments.map((judgment) => judgment.docid),
      judgments: expectedJudgments,
      topDocs: result.docs,
      warmLatencyMs: performance.now() - started,
      error: result.error,
    });
    if (query.normalizationVariant) {
      item.normalization = query.normalizationVariant;
    }
    cases.push(item);
  }

  return {
    id: input.lane,
    description: LANE_DESCRIPTIONS[input.lane],
    config: laneConfig(input.lane),
    queryCount: cases.length,
    metrics: summarizeCjkMetrics(cases),
    latency: {
      coldQueryMs: Number(coldQueryMs.toFixed(2)),
      warmQuery: summarizeLatency(cases.map((item) => item.warmLatencyMs)),
    },
    languages: CJK_BENCH_LANGUAGES.filter((language) =>
      cases.some((item) => item.language === language)
    ).map((language) =>
      summarizeCjkLanguage(
        language,
        cases.filter((item) => item.language === language)
      )
    ),
    cases,
  };
};

const readIndexStats = (
  dbPath: string
): CjkBenchOutput["index"] & {
  sqlite: string;
} => {
  const database = new Database(dbPath, { readonly: true });
  database.exec(
    "CREATE VIRTUAL TABLE temp.cjk_bench_vocab USING fts5vocab('main', 'documents_fts', 'row')"
  );
  const pragma = database
    .query(
      "SELECT page_count AS pageCount, page_size AS pageSize FROM pragma_page_count(), pragma_page_size()"
    )
    .get() as { pageCount: number | bigint; pageSize: number | bigint };
  const vocab = database
    .query(
      "SELECT COUNT(*) AS terms, COALESCE(SUM(doc), 0) AS docs, COALESCE(SUM(cnt), 0) AS occurrences FROM cjk_bench_vocab"
    )
    .get() as {
    terms: number | bigint;
    docs: number | bigint;
    occurrences: number | bigint;
  };
  const sqlite = (
    database.query("SELECT sqlite_version() AS version").get() as {
      version: string;
    }
  ).version;
  database.close();
  return {
    tokenizer: DEFAULT_FTS_TOKENIZER,
    buildMs: 0,
    bytes: Number(pragma.pageCount) * Number(pragma.pageSize),
    pageCount: Number(pragma.pageCount),
    pageSize: Number(pragma.pageSize),
    vocabularyTerms: Number(vocab.terms),
    vocabularyDocuments: Number(vocab.docs),
    tokenOccurrences: Number(vocab.occurrences),
    sqlite,
  };
};

export const runCjkLexicalBenchmark = async (
  options: RunCjkBenchmarkOptions = {}
): Promise<CjkBenchOutput> => {
  const fixture = await loadFixture();
  const languages = options.languages ?? [...CJK_BENCH_LANGUAGES];
  const queryIdSet = options.queryIds ? new Set(options.queryIds) : null;
  const queries = fixture.queries.filter(
    (query) =>
      languages.includes(query.language) &&
      (!queryIdSet || queryIdSet.has(query.id))
  );
  if (queries.length === 0) {
    throw new Error("CJK benchmark selection contains no queries");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "gno-cjk-bench-"));
  const dbPath = join(tempDir, "cjk.sqlite");
  const collection: Collection = {
    name: COLLECTION_NAME,
    path: CORPUS_ROOT,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  const config: Config = {
    version: CONFIG_VERSION,
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [collection],
    contexts: [],
  };
  const store = new SqliteAdapter();
  try {
    const buildStarted = performance.now();
    const open = await store.open(dbPath, DEFAULT_FTS_TOKENIZER);
    if (!open.ok) {
      throw new Error(`Failed to open benchmark index: ${open.error.message}`);
    }
    const collections = await store.syncCollections([collection]);
    if (!collections.ok) {
      throw new Error(
        `Failed to register benchmark corpus: ${collections.error.message}`
      );
    }
    const sync = await new SyncService().syncCollection(collection, store, {
      runUpdateCmd: false,
    });
    if (
      sync.filesErrored > 0 ||
      sync.filesProcessed !== fixture.sources.length
    ) {
      throw new Error(
        `CJK benchmark ingestion mismatch: processed=${sync.filesProcessed} errors=${sync.filesErrored}`
      );
    }
    const buildMs = performance.now() - buildStarted;
    const { sqlite, ...indexStats } = readIndexStats(dbPath);
    const lanes: CjkBenchLaneResult[] = [];
    for (const lane of [
      "bm25",
      "hybrid-no-models",
      "substring-raw",
      "substring-nfc",
    ] as const) {
      lanes.push(
        await runLane({
          lane,
          queries,
          judgments: fixture.judgments,
          store,
          config,
          documents: fixture.documents,
        })
      );
    }

    const corpusFingerprint = fingerprint({
      manifest: fixture.manifest,
      sources: fixture.sources,
      queries: fixture.queries,
      judgments: fixture.judgments,
    });
    const result: CjkBenchOutput = {
      schemaVersion: 1,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      benchmark: "gno-cjk-lexical-degradation",
      corpus: {
        fixtureVersion: fixture.manifest.version,
        documentCount: fixture.sources.length,
        queryCount: queries.length,
        languages,
        provenance: fixture.manifest.provenanceReview.method,
        fingerprint: corpusFingerprint,
      },
      runtime: {
        bun: Bun.version,
        platform: platform(),
        arch: arch(),
        sqlite,
      },
      index: {
        ...indexStats,
        buildMs: Number(buildMs.toFixed(2)),
      },
      fingerprints: {
        config: fingerprint({
          schemaVersion: 1,
          tokenizer: DEFAULT_FTS_TOKENIZER,
          collection: COLLECTION_NAME,
          lanes: lanes.map((lane) => ({ id: lane.id, config: lane.config })),
        }),
        runtime: fingerprint({
          bun: Bun.version,
          platform: platform(),
          arch: arch(),
          sqlite,
        }),
        tokenizer: fingerprint({ tokenizer: DEFAULT_FTS_TOKENIZER, sqlite }),
        result: "",
      },
      lanes,
    };
    result.fingerprints.result = fingerprintStableResult(result);
    return result;
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
};
