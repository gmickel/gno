/** Activated exact-input owner scaling; run after eligible-scaling.ts. */
import { Database } from "bun:sqlite";
// Bun has no directory creation or path utilities.
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type { HybridSearchOptions } from "../../src/pipeline/types";
import type { FtsResult, StoreResult } from "../../src/store/types";
import type { VectorSearchResult } from "../../src/store/vector/types";

import { formatDocForEmbedding } from "../../src/pipeline/contextual";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  createVectorIndexPort,
  encodeEmbedding,
} from "../../src/store/vector/sqlite-vec";
import { resolveVectorSearchIdentity } from "../../src/store/vector/variant-search";
import {
  createVectorVariantStore,
  embeddingInputHash,
} from "../../src/store/vector/variants";
import { canonicalFingerprint } from "../agentic/canonical";
import { percentile, scalingCorpus } from "./eligible-scaling";

const model = "synthetic:eligible-scaling-v1";
const embedPort: EmbeddingPort = {
  modelUri: model,
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
  getIdentity: () => ({
    contextSize: 512,
    truncationPolicy: "synthetic-tail-v1",
    modelFingerprint: "known-2d-v1",
    runtimeFingerprint: "known-cpu-v1",
  }),
};
const identity = resolveVectorSearchIdentity(embedPort)!;
const queryVector = new Float32Array([1, 0]);
const config = {} as Config;
const root = ".flow/artifacts/fn-148-eligible-candidates-before-retrieval";
const protocol = {
  version: "eligible-variant-scaling-v1",
  identity,
  sizes: [201, 2001, 10001],
  limits: [1, 10],
  concurrency: [1, 4],
  repetitions: 5,
  timerMs: 1,
  addedOwners: ["Alpha", "Beta", "Alpha copy"],
};
type Workload =
  | "broad"
  | "rare-tag"
  | "beta-owner"
  | "whole-document-exclusion"
  | "empty-scope";
type Surface = "vector" | "hybrid";
const workloads: Workload[] = [
  "broad",
  "rare-tag",
  "beta-owner",
  "whole-document-exclusion",
  "empty-scope",
];
const must = <T>(value: StoreResult<T>): T => {
  if (!value.ok) throw new Error(`${value.error.code}: ${value.error.message}`);
  return value.value;
};
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const optionsFor = (
  workload: Workload,
  limit: number
): HybridSearchOptions => ({
  limit,
  lang: "en",
  noExpand: true,
  noRerank: true,
  noGraph: true,
  ...(workload === "rare-tag" ? { tagsAll: ["rare"] } : {}),
  ...(workload === "beta-owner" ? { tagsAll: ["beta"] } : {}),
  ...(workload === "whole-document-exclusion" ? { exclude: ["noise"] } : {}),
  ...(workload === "empty-scope"
    ? { retrievalScope: { allowedMirrorHashes: [] } }
    : {}),
});

async function reader(path: string) {
  const store = new SqliteAdapter();
  must(await store.open(path, "unicode61"));
  const db = new Database(path);
  const vector = must(
    await createVectorIndexPort(db, { model, dimensions: 2 })
  );
  if (!vector.searchAvailable)
    throw new Error(`VEC_SEARCH_UNAVAILABLE: ${vector.loadError}`);
  return { store, db, vector };
}
type Client = Awaited<ReturnType<typeof reader>>;
async function setup(size: number, previousDirectory: string) {
  if (!process.env.TMPDIR)
    throw new Error("Set isolated TMPDIR outside the repository");
  const directory = await mkdtemp(
    join(process.env.TMPDIR, `variant-scaling-${size}-`)
  );
  const path = join(directory, "index.sqlite");
  const source = new Database(join(previousDirectory, "index.sqlite"), {
    readonly: true,
  });
  try {
    source.query("VACUUM INTO ?").run(path);
  } finally {
    source.close();
  }
  const client = await reader(path);
  const fixture = scalingCorpus(size);
  const target = fixture.at(-1)!;
  client.db.query("UPDATE documents SET title='Alpha' WHERE id=?").run(size);
  const owners = fixture.map((item) => ({
    id: item.index + 1,
    uri: item.uri,
    hash: item.hash,
    title: item.rare ? "Alpha" : "Record",
    text: item.text,
    active: item.active,
    rare: item.rare,
    beta: false,
  }));
  for (const [offset, title] of [
    [1, "Beta"],
    [2, "Alpha"],
  ] as const) {
    const relPath = `scope/title-owner-${offset}.md`;
    const inserted = must(
      await client.store.upsertDocument({
        collection: "scaling",
        relPath,
        sourceHash: canonicalFingerprint({
          version: protocol.version,
          size,
          title,
          offset,
        }),
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: target.text.length,
        sourceMtime: "2026-09-01T00:00:00.000Z",
        title,
        mirrorHash: target.hash,
      })
    );
    must(
      await client.store.setDocTags(
        inserted.id,
        [offset === 1 ? "beta" : "alpha-copy"],
        "frontmatter"
      )
    );
    owners.push({
      id: inserted.id,
      uri: `gno://scaling/${relPath}`,
      hash: target.hash,
      title,
      text: target.text,
      active: true,
      rare: false,
      beta: offset === 1,
    });
  }
  must(await client.store.rebuildFtsForHash(target.hash));
  const variants = await createVectorVariantStore(client.db, identity);
  for (;;) {
    const pending = variants.pending({ limit: 1000 });
    if (!pending.length) break;
    variants.write(
      pending.map((owner) => ({
        owner,
        embedding: new Float32Array(
          owner.documentId === size || owner.documentId === size + 2
            ? [1, 0]
            : owner.documentId === size + 1
              ? [0, 1]
              : fixture[owner.documentId - 1]!.vector
        ),
      }))
    );
  }
  variants.activate(variants.epoch());
  if (!variants.hasActivated() || !variants.isActive())
    throw new Error("Synthetic partition did not activate");
  return { client, owners, variants, path, directory };
}
type State = Awaited<ReturnType<typeof setup>>;
function allowedOwners(state: State, workload: Workload) {
  return new Set(
    state.owners
      .filter(
        (owner) =>
          owner.active &&
          workload !== "empty-scope" &&
          (workload === "broad" ||
            (workload === "rare-tag" && owner.rare) ||
            (workload === "beta-owner" && owner.beta) ||
            (workload === "whole-document-exclusion" &&
              !owner.text.includes("noise")))
      )
      .map((owner) => owner.id)
  );
}
type Binding = {
  documentId: number;
  mirrorHash: string;
  seq: number;
  text: string;
  title: string | null;
  inputHash: string;
  variantId: number;
  distance: number;
};
function allBindings(state: State): Binding[] {
  return state.client.db
    .query<
      Binding,
      (Uint8Array | string)[]
    >(`SELECT o.document_id AS documentId, o.mirror_hash AS mirrorHash, o.seq, c.text, d.title, v.input_hash AS inputHash, v.variant_id AS variantId, vec_distance_cosine(v.embedding, ?) AS distance
    FROM vector_owners o JOIN documents d ON d.id=o.document_id AND d.active=1 AND d.mirror_hash=o.mirror_hash JOIN content_chunks c ON c.mirror_hash=o.mirror_hash AND c.seq=o.seq JOIN vector_variants v ON v.variant_id=o.variant_id AND v.partition_id=o.partition_id WHERE o.partition_id=? ORDER BY distance, o.mirror_hash, o.seq, v.variant_id, o.document_id`)
    .all(encodeEmbedding(queryVector), state.variants.partitionId);
}
function proof(bindings: Binding[]) {
  return bindings.filter(
    (row) =>
      row.inputHash ===
      embeddingInputHash(
        formatDocForEmbedding(row.text, row.title ?? undefined, model)
      )
  );
}
async function oracle(state: State, workload: Workload) {
  const allowed = allowedOwners(state, workload);
  const bindings = proof(
    allBindings(state).filter((row) => allowed.has(row.documentId))
  );
  const grouped = new Map<number, VectorSearchResult>();
  for (const row of bindings) {
    const hit = grouped.get(row.variantId) ?? {
      mirrorHash: row.mirrorHash,
      seq: row.seq,
      distance: row.distance,
      documentIds: [],
    };
    hit.documentIds!.push(row.documentId);
    grouped.set(row.variantId, hit);
  }
  const vectors = [...grouped.values()];
  const uris = new Set(
    state.owners
      .filter((owner) => allowed.has(owner.id))
      .map((owner) => owner.uri)
  );
  const lexical = must(
    await state.client.store.searchFts("needle", {
      limit: state.owners.length + 1,
      snippet: true,
    })
  ).filter((row) => row.uri !== undefined && uris.has(row.uri));
  const store = new Proxy(state.client.store, {
    get(target, key) {
      if (key === "searchFts")
        return (
          _query: string,
          options: { limit?: number } = {}
        ): Promise<StoreResult<FtsResult[]>> =>
          Promise.resolve({
            ok: true,
            value: lexical.slice(0, options.limit ?? 20),
          });
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const vector = {
    ...state.client.vector,
    searchNearest: (
      _query: Float32Array,
      k: number
    ): Promise<StoreResult<VectorSearchResult[]>> =>
      Promise.resolve({ ok: true, value: vectors.slice(0, k) }),
  };
  return {
    store,
    vector,
    vectors,
    eligibleOwners: allowed.size,
    provenOwners: bindings.length,
  };
}
async function retrieve(
  client: Pick<Client, "store" | "vector">,
  surface: Surface,
  options: HybridSearchOptions
) {
  return surface === "vector"
    ? must(
        await searchVectorWithEmbedding(
          {
            store: client.store,
            vectorIndex: client.vector,
            embedPort,
            config,
          },
          "needle",
          queryVector,
          options
        )
      )
    : must(
        await searchHybrid(
          {
            store: client.store,
            vectorIndex: client.vector,
            embedPort,
            config,
            expandPort: null,
            rerankPort: null,
          },
          "needle",
          options
        )
      );
}

async function run() {
  const label = process.argv[2] ?? "initial";
  const legacyLabel = process.argv[3] ?? "exists-known-vectors";
  if (![label, legacyLabel].every((value) => /^[a-zA-Z0-9._-]+$/.test(value)))
    throw new Error("Labels must be safe single components");
  const output = join(root, "variant-scaling", label);
  await mkdir(output, { recursive: true });
  const reportPath = join(output, "report.json");
  if (await Bun.file(reportPath).exists())
    throw new Error("Refusing to overwrite capture");
  const legacy = await Bun.file(join(root, legacyLabel, "report.json")).json();
  const pins = {
    ...protocol,
    corpora: protocol.sizes.map((size) => ({
      size,
      baseSha256: canonicalFingerprint(scalingCorpus(size)),
      ownerScenarioSha256: canonicalFingerprint({
        size,
        titles: ["Alpha", "Beta", "Alpha"],
        alphaVector: [1, 0],
        betaVector: [0, 1],
        staleTitle: "Unembedded changed Alpha",
      }),
    })),
  };
  const pinPath = join(root, "variant-scaling", "manifest.json");
  if (await Bun.file(pinPath).exists()) {
    if (
      canonicalFingerprint(await Bun.file(pinPath).json()) !==
      canonicalFingerprint(pins)
    )
      throw new Error("Variant scenario pin drift");
  } else await Bun.write(pinPath, JSON.stringify(pins, null, 2));
  const sourcePaths = [
    "src/store/vector/variant-search.ts",
    "src/store/vector/variants.ts",
    "src/store/vector/sqlite-vec.ts",
    "src/store/sqlite/eligibility.ts",
    "src/store/sqlite/adapter.ts",
    "src/pipeline/vsearch.ts",
    "src/pipeline/hybrid.ts",
    "src/pipeline/owner-fusion.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        canonicalFingerprint(await Bun.file(path).text()),
      ])
    )
  );
  const frames: Record<string, unknown> = {};
  const frame = (rows: unknown) => {
    const value = wire(rows);
    const hash = canonicalFingerprint(value);
    frames[hash] = value;
    return hash;
  };
  const report = {
    protocol: pins,
    commit: (await Bun.$`git rev-parse HEAD`.quiet().text()).trim(),
    sourceHashes,
    scriptSha256: canonicalFingerprint(await Bun.file(import.meta.path).text()),
    phase: "incomplete",
    interpretation:
      "Activated owner variants; two extra owners sharing target content, distinct title inputs. Separate semantic stratum from legacy, never direct ranking parity. Warm same-event-loop overlapping independent SQLite readers. Full unique output frames retained by hash. Hash-stage diagnostic performs actual production formatter+SHA on eligible binding rows, separately from end-to-end timing; it is not an instrumentation subtraction.",
    frames,
    errors: [] as string[],
    corpora: [] as unknown[],
  };
  const save = () =>
    Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (const size of protocol.sizes) {
    const clients: Client[] = [];
    try {
      const started = performance.now();
      const previous = legacy.corpora.find(
        (corpus: { size: number }) => corpus.size === size
      );
      if (!previous) throw new Error("Missing prerequisite legacy corpus");
      const state = await setup(size, previous.directory);
      clients.push(state.client);
      while (clients.length < 4) clients.push(await reader(state.path));
      const corpus = {
        size,
        actualOwners: state.owners.length,
        directory: state.directory,
        setupMs: performance.now() - started,
        activated: state.variants.isActive(),
        cases: [] as unknown[],
        hashStage: [] as unknown[],
        checks: [] as unknown[],
      };
      report.corpora.push(corpus);
      await save();
      for (const workload of workloads) {
        const allowed = allowedOwners(state, workload);
        for (let repetition = 0; repetition < 5; repetition++) {
          const rows = allBindings(state).filter((row) =>
            allowed.has(row.documentId)
          );
          const start = performance.now();
          const proven = proof(rows);
          const hashMs = performance.now() - start;
          corpus.hashStage.push({
            workload,
            repetition,
            owners: rows.length,
            inputUtf8Bytes: rows.reduce(
              (total, row) =>
                total +
                new TextEncoder().encode(
                  formatDocForEmbedding(row.text, row.title ?? undefined, model)
                ).byteLength,
              0
            ),
            proven: proven.length,
            formatterAndShaMs: hashMs,
          });
        }
        const reference = await oracle(state, workload);
        for (const surface of ["vector", "hybrid"] as const)
          for (const limit of protocol.limits) {
            const options = optionsFor(workload, limit);
            const expectedHash = frame(
              (await retrieve(reference, surface, options)).results
            );
            for (const concurrency of protocol.concurrency) {
              const entry = {
                workload,
                surface,
                limit,
                concurrency,
                expectedHash,
                eligibleOwners: reference.eligibleOwners,
                provenOwners: reference.provenOwners,
                incomplete: true,
                waves: [] as unknown[],
                p95ResponseMs: null as number | null,
                maxTimerDelayMs: 0,
              };
              corpus.cases.push(entry);
              await save();
              const responses: number[] = [];
              for (
                let repetition = 0;
                repetition < protocol.repetitions;
                repetition++
              ) {
                const start = performance.now();
                const timer = new Promise<number>((resolve) =>
                  setTimeout(
                    () => resolve(Math.max(0, performance.now() - start - 1)),
                    1
                  )
                );
                const samples = await Promise.all(
                  clients
                    .slice(0, concurrency)
                    .map(async (client, readerId) => {
                      const requestStart = performance.now();
                      try {
                        const result = await retrieve(client, surface, options);
                        const responseMs = performance.now() - start;
                        const outputHash = frame(result.results);
                        const exact = outputHash === expectedHash;
                        if (repetition > 0) responses.push(responseMs);
                        if (!exact)
                          report.errors.push(
                            `${size}/${workload}/${surface}/${limit}/${concurrency}/${repetition}/${readerId}: output mismatch`
                          );
                        return {
                          readerId,
                          startOffsetMs: requestStart - start,
                          responseMs,
                          exact,
                          outputHash,
                        };
                      } catch (error) {
                        report.errors.push(String(error));
                        return {
                          readerId,
                          startOffsetMs: requestStart - start,
                          responseMs: performance.now() - start,
                          exact: false,
                          error: String(error),
                        };
                      }
                    })
                );
                const timerDelayMs = await timer;
                entry.maxTimerDelayMs = Math.max(
                  entry.maxTimerDelayMs,
                  timerDelayMs
                );
                entry.waves.push({ repetition, timerDelayMs, samples });
                await save();
                if (report.errors.length)
                  throw new Error(
                    "Stopping on first failing wave; preserve output frames"
                  );
              }
              entry.p95ResponseMs = percentile(responses, 0.95);
              entry.incomplete = false;
              await save();
            }
          }
      }
      state.client.db
        .query(
          "UPDATE documents SET title='Unembedded changed Alpha' WHERE id=?"
        )
        .run(size);
      for (const workload of ["broad", "rare-tag"] as const) {
        const reference = await oracle(state, workload);
        const options = optionsFor(workload, 1);
        const expectedHash = frame(
          (await retrieve(reference, "vector", options)).results
        );
        const outputHash = frame(
          (await retrieve(state.client, "vector", options)).results
        );
        corpus.checks.push({
          scenario: "stale-title-before-K",
          workload,
          expectedHash,
          outputHash,
          exact: expectedHash === outputHash,
        });
        if (expectedHash !== outputHash)
          throw new Error("Stale owner output mismatch");
      }
      const missingIdentity = await state.client.vector.searchNearest(
        queryVector,
        1,
        { eligibility: {} }
      );
      corpus.checks.push({
        scenario: "missing-identity-after-activation",
        result: missingIdentity,
        exact: !missingIdentity.ok,
      });
      if (missingIdentity.ok)
        throw new Error("Activated partition silently fell back to legacy");
      console.info(
        `Activated variant ${size}: ${corpus.cases.length} groups captured`
      );
    } catch (error) {
      report.errors.push(`${size}: ${String(error)}`);
      await save();
      break;
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
