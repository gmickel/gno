/** Pinned synthetic eligible-domain scaling probe; no models or private indexes. */
import { Database } from "bun:sqlite";
// Bun has no directory creation or path equivalents.
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type {
  HybridSearchOptions,
  SearchResults,
} from "../../src/pipeline/types";
import type { FtsResult, StoreResult } from "../../src/store/types";
import type { VectorSearchResult } from "../../src/store/vector/types";

import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  createVectorIndexPort,
  encodeEmbedding,
} from "../../src/store/vector/sqlite-vec";
import { canonicalFingerprint } from "../agentic/canonical";

const protocol = {
  version: "eligible-scaling-v1",
  sizes: [201, 2001, 10001],
  concurrency: [1, 4],
  repetitions: 5,
  limits: [1, 10],
  timerMs: 1,
};
const root = ".flow/artifacts/fn-148-eligible-candidates-before-retrieval";
const queryVector = new Float32Array([1, 0]);
const model = "synthetic:eligible-scaling-v1";
const config = {} as Config;
const embedding: EmbeddingPort = {
  modelUri: model,
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
};

export function scalingCorpus(size: number) {
  return Array.from({ length: size }, (_, index) => {
    const rare = index === size - 1;
    const text = `needle ${rare ? "target" : "noise"} ${index} ${"background ".repeat(4 + (index % 29))}`;
    const hash = canonicalFingerprint({
      version: protocol.version,
      index,
      text,
    });
    const relPath = `scope/${String(index).padStart(6, "0")}.md`;
    const t = (index + 1) / (size + 1);
    return {
      index,
      rare,
      text,
      hash,
      relPath,
      uri: `gno://scaling/${relPath}`,
      active: rare || index % 97 !== 0,
      vector: [1 - t * 0.8, t * 0.8],
    };
  });
}

type Fixture = ReturnType<typeof scalingCorpus>;
function must<T>(result: StoreResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function makeIndex(fixture: Fixture, directory: string) {
  const path = join(directory, "index.sqlite");
  const store = new SqliteAdapter();
  must(await store.open(path, "unicode61"));
  must(
    await store.syncCollections([
      {
        name: "scaling",
        path: directory,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ])
  );
  const db = new Database(path);
  const content = db.prepare(
    "INSERT INTO content(mirror_hash, markdown) VALUES (?, ?)"
  );
  const document = db.prepare(
    `INSERT INTO documents(id, collection, rel_path, source_hash, source_mime, source_ext, source_size, source_mtime, docid, uri, title, mirror_hash, fts_mirror_hash, active, author, categories) VALUES (?, 'scaling', ?, ?, 'text/markdown', '.md', ?, '2026-09-01T00:00:00.000Z', ?, ?, 'Record', ?, ?, ?, 'Fixture author', '["fixture"]')`
  );
  const chunk = db.prepare(
    "INSERT INTO content_chunks(mirror_hash, seq, pos, text, start_line, end_line, language) VALUES (?, 0, 0, ?, 1, 1, 'en')"
  );
  const fts = db.prepare(
    "INSERT INTO documents_fts(rowid, filepath, title, body) VALUES (?, ?, 'Record', ?)"
  );
  const tag = db.prepare(
    "INSERT INTO doc_tags(document_id, tag, source) VALUES (?, ?, 'frontmatter')"
  );
  db.transaction(() => {
    for (const item of fixture) {
      content.run(item.hash, item.text);
      document.run(
        item.index + 1,
        item.relPath,
        item.hash,
        item.text.length,
        `#${item.hash.slice(0, 8)}`,
        item.uri,
        item.hash,
        item.hash,
        Number(item.active)
      );
      chunk.run(item.hash, item.text);
      fts.run(item.index + 1, item.relPath, item.text);
      tag.run(item.index + 1, item.rare ? "rare" : "noise");
    }
  })();
  const vector = must(
    await createVectorIndexPort(db, { model, dimensions: 2 })
  );
  if (!vector.searchAvailable)
    throw new Error(`VEC_SEARCH_UNAVAILABLE: ${vector.loadError}`);
  must(
    await vector.upsertVectors(
      fixture.map((item) => ({
        mirrorHash: item.hash,
        seq: 0,
        model,
        embedFingerprint: protocol.version,
        embedding: new Float32Array(item.vector),
      }))
    )
  );
  if (vector.vecDirty) throw new Error("Synthetic vec0 writes failed");
  return { store, db, vector, path };
}

type Client = Awaited<ReturnType<typeof makeIndex>>;
type Surface = "lexical" | "vector" | "hybrid";
type Workload =
  | "broad"
  | "rare-tag"
  | "whole-document-exclusion"
  | "empty-scope";
const surfaces: Surface[] = ["lexical", "vector", "hybrid"];
const workloads: Workload[] = [
  "broad",
  "rare-tag",
  "whole-document-exclusion",
  "empty-scope",
];
function optionsFor(workload: Workload, limit: number): HybridSearchOptions {
  return {
    limit,
    noExpand: true,
    noRerank: true,
    noGraph: true,
    lang: "en",
    ...(workload === "rare-tag" ? { tagsAll: ["rare"] } : {}),
    ...(workload === "whole-document-exclusion" ? { exclude: ["noise"] } : {}),
    ...(workload === "empty-scope"
      ? { retrievalScope: { allowedMirrorHashes: [] } }
      : {}),
  };
}
function eligibleHashes(fixture: Fixture, workload: Workload): Set<string> {
  return new Set(
    fixture
      .filter(
        (item) =>
          item.active &&
          workload !== "empty-scope" &&
          (workload === "broad" || item.rare)
      )
      .map((item) => item.hash)
  );
}
async function retrieve(
  client: Pick<Client, "store" | "vector">,
  surface: Surface,
  options: HybridSearchOptions
): Promise<SearchResults> {
  if (surface === "lexical")
    return must(await searchBm25(client.store, "needle", options));
  if (surface === "vector")
    return must(
      await searchVectorWithEmbedding(
        {
          store: client.store,
          vectorIndex: client.vector,
          config,
          embedPort: embedding,
        },
        "needle",
        queryVector,
        options
      )
    );
  return must(
    await searchHybrid(
      {
        store: client.store,
        config,
        vectorIndex: client.vector,
        embedPort: embedding,
        expandPort: null,
        rerankPort: null,
      },
      "needle",
      options
    )
  );
}

/** Compare complete ordered public result rows; timing metadata is deliberately absent. */
function outputIdentity(result: SearchResults) {
  return canonicalFingerprint(JSON.parse(JSON.stringify(result.results)));
}
async function exhaustiveOracle(
  client: Client,
  fixture: Fixture,
  workload: Workload
) {
  // Enumerate all active lexical rows without restrictive filters or a short budget.
  const fts = must(
    await client.store.searchFts("needle", {
      limit: fixture.length + 1,
      snippet: true,
    })
  );
  const vectors = client.db
    .query<VectorSearchResult, (Uint8Array | string)[]>(
      "SELECT mirror_hash AS mirrorHash, seq, vec_distance_cosine(embedding, ?) AS distance FROM content_vectors WHERE model = ? ORDER BY distance, mirror_hash, seq"
    )
    .all(encodeEmbedding(queryVector), model);
  const allowed = eligibleHashes(fixture, workload);
  const lexicalRows = fts.filter((row) => allowed.has(row.mirrorHash));
  const vectorRows = vectors.filter((row) => allowed.has(row.mirrorHash));
  const oracleStore = new Proxy(client.store, {
    get(target, key) {
      if (key === "searchFts")
        return (
          _query: string,
          options: { limit?: number } = {}
        ): Promise<StoreResult<FtsResult[]>> =>
          Promise.resolve({
            ok: true,
            value: lexicalRows.slice(0, options.limit ?? 20),
          });
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const oracleVector = {
    ...client.vector,
    searchNearest: (
      _embedding: Float32Array,
      k: number,
      options?: { minScore?: number }
    ): Promise<StoreResult<VectorSearchResult[]>> =>
      Promise.resolve({
        ok: true,
        value: vectorRows
          .filter(
            (row) =>
              options?.minScore === undefined ||
              1 - row.distance >= options.minScore
          )
          .slice(0, k),
      }),
  };
  return {
    store: oracleStore,
    vector: oracleVector,
    eligibleCount: allowed.size,
    lexicalRows,
    vectorRows,
  };
}

interface Sample {
  repetition: number;
  reader: number;
  startOffsetMs: number;
  durationMs: number;
  responseMs: number;
  matches: boolean;
  outputHash?: string;
  error?: string;
}
interface Wave {
  repetition: number;
  wallMs: number;
  timerDelayMs: number;
  samples: Sample[];
}
export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
    ] ?? null
  );
}
async function wave(
  clients: Client[],
  surface: Surface,
  options: HybridSearchOptions,
  expected: string,
  repetition: number
): Promise<Wave> {
  const started = performance.now();
  const timer = new Promise<number>((resolve) =>
    setTimeout(
      () =>
        resolve(Math.max(0, performance.now() - started - protocol.timerMs)),
      protocol.timerMs
    )
  );
  const samples = await Promise.all(
    clients.map(async (client, reader): Promise<Sample> => {
      const requestStart = performance.now();
      try {
        const output = await retrieve(client, surface, options);
        const finished = performance.now();
        const outputHash = outputIdentity(output);
        return {
          repetition,
          reader,
          startOffsetMs: requestStart - started,
          durationMs: finished - requestStart,
          responseMs: finished - started,
          matches: outputHash === expected,
          outputHash,
        };
      } catch (error) {
        return {
          repetition,
          reader,
          startOffsetMs: requestStart - started,
          durationMs: performance.now() - requestStart,
          responseMs: performance.now() - started,
          matches: false,
          error: String(error),
        };
      }
    })
  );
  const wallMs = performance.now() - started;
  return { repetition, wallMs, timerDelayMs: await timer, samples };
}

async function run() {
  const label =
    process.argv[2] ?? new Date().toISOString().replaceAll(":", "-");
  if (!/^[a-zA-Z0-9._-]+$/.test(label))
    throw new Error("Run label must be a single safe path component");
  const output = join(root, label);
  await mkdir(output, { recursive: true });
  const reportPath = join(output, "report.json");
  if (await Bun.file(reportPath).exists())
    throw new Error(`Refusing to overwrite ${reportPath}`);
  const pin = {
    ...protocol,
    corpora: protocol.sizes.map((size) => ({
      size,
      sha256: canonicalFingerprint(scalingCorpus(size)),
    })),
  };
  const pinPath = join(root, "scaling-manifest.json");
  if (await Bun.file(pinPath).exists()) {
    if (
      canonicalFingerprint(await Bun.file(pinPath).json()) !==
      canonicalFingerprint(pin)
    )
      throw new Error(
        "Scaling manifest mismatch; preserve pins and investigate"
      );
  } else await Bun.write(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  const commit = (await Bun.$`git rev-parse HEAD`.quiet().text()).trim();
  const status = (await Bun.$`git status --porcelain`.quiet().text()).trim();
  const retrievalSources = [
    "src/pipeline/search.ts",
    "src/pipeline/hybrid.ts",
    "src/pipeline/vsearch.ts",
    "src/store/sqlite/adapter.ts",
    "src/store/sqlite/eligibility.ts",
    "src/store/vector/sqlite-vec.ts",
    "src/store/vector/eligibility.ts",
  ];
  const retrievalSourceHashes = Object.fromEntries(
    await Promise.all(
      retrievalSources.map(async (path) => [
        path,
        canonicalFingerprint(await Bun.file(path).text()),
      ])
    )
  );
  const report = {
    schema: protocol.version,
    retrievalSourceHashes,
    commit,
    status,
    scriptSha256: canonicalFingerprint(await Bun.file(import.meta.path).text()),
    startedAt: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    protocol: pin,
    phase: "incomplete",
    interpretation:
      "Known vectors, real SQLite/sqlite-vec and exported retrieval pipelines. Same-event-loop overlapping reads on independent connections; no GGUF/HTTP/UI evidence. Timer delay includes synchronous SQL plus queued microtasks. First measured and steady samples retained; oracle enumeration and oracle pipeline scoring warm caches before timing, so this is not a cold-start measurement. No performance acceptance threshold or promotion verdict inferred.",
    errors: [] as string[],
    corpora: [] as unknown[],
  };
  const save = () =>
    Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (const size of protocol.sizes) {
    const clients: Client[] = [];
    try {
      const fixture = scalingCorpus(size);
      const temporaryRoot = process.env.TMPDIR;
      if (!temporaryRoot)
        throw new Error("Set TMPDIR to an isolated directory outside the repo");
      const directory = await mkdtemp(
        join(temporaryRoot, `eligible-scaling-${size}-`)
      );
      const setupStarted = performance.now();
      clients.push(await makeIndex(fixture, directory));
      for (let i = 1; i < Math.max(...protocol.concurrency); i++) {
        const store = new SqliteAdapter();
        must(await store.open(clients[0]!.path, "unicode61"));
        const db = new Database(clients[0]!.path);
        const vector = must(
          await createVectorIndexPort(db, { model, dimensions: 2 })
        );
        if (!vector.searchAvailable)
          throw new Error("Reader vector capability missing");
        clients.push({ store, db, vector, path: clients[0]!.path });
      }
      const corpus = {
        size,
        directory,
        setupMs: performance.now() - setupStarted,
        vectorAvailable: true,
        timerControlMs: [] as number[],
        cases: [] as unknown[],
      };
      report.corpora.push(corpus);
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await Bun.sleep(protocol.timerMs);
        corpus.timerControlMs.push(
          Math.max(0, performance.now() - start - protocol.timerMs)
        );
      }
      for (const workload of workloads) {
        const oracle = await exhaustiveOracle(clients[0]!, fixture, workload);
        for (const surface of surfaces)
          for (const limit of protocol.limits) {
            const options = optionsFor(workload, limit);
            const expected = await retrieve(oracle, surface, options);
            const expectedHash = outputIdentity(expected);
            for (const concurrency of protocol.concurrency) {
              const waves: Wave[] = [];
              const entry = {
                workload,
                surface,
                limit,
                concurrency,
                options,
                eligibleCount: oracle.eligibleCount,
                expectedHash,
                expectedRows: expected.results,
                exact: false,
                incomplete: true,
                sampleCount: 0,
                waves,
                steadyResponseMs: {
                  p50: null as number | null,
                  p95: null as number | null,
                  max: null as number | null,
                },
                maxTimerDelayMs: 0,
              };
              corpus.cases.push(entry);
              await save();
              for (
                let repetition = 0;
                repetition < protocol.repetitions;
                repetition++
              ) {
                waves.push(
                  await wave(
                    clients.slice(0, concurrency),
                    surface,
                    options,
                    expectedHash,
                    repetition
                  )
                );
                entry.sampleCount += concurrency;
                await save();
              }
              const samples = waves.flatMap((item) => item.samples);
              const steady = samples
                .filter((item) => item.repetition > 0)
                .map((item) => item.responseMs);
              Object.assign(entry, {
                exact: samples.every((item) => item.matches),
                incomplete: false,
                steadyResponseMs: {
                  p50: percentile(steady, 0.5),
                  p95: percentile(steady, 0.95),
                  max: percentile(steady, 1),
                },
                maxTimerDelayMs: Math.max(
                  ...waves.map((item) => item.timerDelayMs)
                ),
              });
              if (!entry.exact)
                report.errors.push(
                  `${size}/${workload}/${surface}/${limit}/${concurrency}: exact output mismatch or request failure`
                );
              await save();
            }
          }
      }
      console.info(
        `Captured ${size} documents; ${corpus.cases.length} cases; failures=${report.errors.length}`
      );
    } catch (error) {
      report.errors.push(`${size}: ${String(error)}`);
      await save();
    } finally {
      for (const client of clients) {
        client.db.close();
        await client.store.close();
      }
    }
  }
  report.phase = report.errors.length
    ? "failed"
    : "captured-needs-host-performance-review";
  await save();
  console.info(reportPath);
  if (report.errors.length) process.exitCode = 1;
}

if (import.meta.main) await run();
