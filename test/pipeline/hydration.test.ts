import { expect, test } from "bun:test";

import type { AcceptanceManifest } from "../../evals/acceptance/manifest";
import type {
  AcceptanceRecord,
  DeterministicRecord,
} from "../../evals/acceptance/records";
import type { DocumentRow, StorePort } from "../../src/store/types";

import { compareAcceptance } from "../../evals/acceptance/compare";
import { acceptanceManifestFingerprint } from "../../evals/acceptance/manifest";
import { hydrationLongDocument } from "../../evals/fixtures/acceptance/hydration-long-doc/fixture";
import pin from "../../evals/fixtures/acceptance/hydration-long-doc/manifest.json";
import { RequestHydration } from "../../src/pipeline/hydration";
import { rerankCandidates } from "../../src/pipeline/rerank";
import { searchBm25 } from "../../src/pipeline/search";
import { err, ok } from "../../src/store/types";

const hash = "hydration-long-doc-v1";
const fixture = hydrationLongDocument();

function measuredStore() {
  const counts = { reads: 0, rows: 0, bytes: 0 };
  const store = {
    getChunksBatch: async (hashes: string[]) => {
      counts.reads++;
      const rows = hashes.includes(hash) ? structuredClone(fixture.chunks) : [];
      counts.rows += rows.length;
      counts.bytes += rows.reduce(
        (sum, row) => sum + Buffer.byteLength(row.text),
        0
      );
      return ok(new Map(rows.length ? [[hash, rows]] : []));
    },
    getContentBatch: async () => {
      counts.reads++;
      counts.rows++;
      counts.bytes += Buffer.byteLength(fixture.content);
      return ok(new Map([[hash, fixture.content]]));
    },
    getCollections: async () =>
      ok([
        {
          name: "test",
          path: "/synthetic",
          egressPolicy: "local_only",
          egressPolicySource: "legacy_default",
        },
      ]),
    searchFts: async () =>
      ok([
        {
          mirrorHash: hash,
          seq: 777,
          score: -2,
          docid: "#long",
          uri: "gno://test/long.md",
          title: "Long document",
          collection: "test",
          relPath: "long.md",
        },
      ]),
  } as unknown as StorePort;
  return { counts, store };
}

function manifest(role: "baseline" | "candidate"): AcceptanceManifest {
  return {
    schemaVersion: "gno-acceptance-v1",
    role,
    identity: {
      commit: "0".repeat(40),
      indexId: "synthetic-hydration-unit",
      indexSha256: pin.sha256,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: pin.version,
    fixtures: [
      { path: "hydration-long-doc/generated.json", sha256: pin.sha256 },
    ],
    models: [],
    cases: [
      {
        caseId: "long-doc",
        fixtureSha256: pin.sha256,
        surface: "sdk",
        preset: "unit",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
}

async function capture(cached: boolean): Promise<{
  counts: ReturnType<typeof measuredStore>["counts"];
  record: AcceptanceRecord;
}> {
  const { store, counts } = measuredStore();
  const hydration = new RequestHydration(store);
  const reader = cached
    ? {
        ...store,
        getChunksBatch: hydration.getChunksBatch.bind(hydration),
        getContentBatch: hydration.getContentBatch.bind(hydration),
      }
    : store;
  const modelInputs: DeterministicRecord["modelInputs"] = [];
  try {
    const search = await searchBm25(reader, "needle evidence");
    expect(search.ok).toBe(true);
    const reranks = [];
    for (const modelId of ["unit-rerank-a", "unit-rerank-b"]) {
      reranks.push(
        await rerankCandidates(
          {
            store: reader,
            rerankPort: {
              modelUri: modelId,
              rerank: async (query, documents) => {
                modelInputs.push({
                  role: "reranking",
                  modelId,
                  input: { query, documents },
                });
                return {
                  ok: true as const,
                  value: documents.map((_, index) => ({
                    index,
                    score: 0.75,
                    rank: index + 1,
                  })),
                };
              },
              dispose: async () => {},
            },
          },
          "needle evidence",
          [777, 0].map((seq) => ({
            mirrorHash: hash,
            seq,
            bm25Rank: seq === 777 ? 1 : 2,
            fusionScore: seq === 777 ? 0.5 : 0.25,
            vecRank: null,
            sources: ["bm25"],
          }))
        )
      );
      const content = await reader.getContentBatch!([hash, hash]);
      expect(content.ok && content.value.get(hash)).toBe(fixture.content);
    }
    // Include the complete public output, not a score-only projection.
    const completeOutput = JSON.parse(JSON.stringify({ search, reranks }));
    return {
      counts,
      record: {
        schemaVersion: "gno-acceptance-v1",
        manifestSha256: acceptanceManifestFingerprint(
          manifest(cached ? "candidate" : "baseline")
        ),
        caseId: "long-doc",
        deterministic: {
          scope: { completeOutput },
          results: [],
          citations: [],
          modelInputs,
          semanticState: {
            status: "ok",
            vectorsUsed: false,
            vectorStatus: "not-requested",
            error: null,
            fallbacks: [],
            verification: null,
          },
        },
        generatedAnswer: null,
        transport: {},
      },
    };
  } finally {
    hydration.release();
  }
}

test("1,000 chunks: fewer reads/rows/UTF-8 bytes with exact public output and actual model input parity", async () => {
  const encoded = JSON.stringify(fixture);
  expect(new Bun.CryptoHasher("sha256").update(encoded).digest("hex")).toBe(
    pin.sha256
  );
  expect(Buffer.byteLength(encoded)).toBe(pin.utf8Bytes);
  expect(fixture.chunks).toHaveLength(pin.chunks);
  const baseline = await capture(false);
  const candidate = await capture(true);
  expect(
    compareAcceptance(
      manifest("baseline"),
      manifest("candidate"),
      [baseline.record],
      [candidate.record]
    ).passed
  ).toBe(true);
  const chunkBytes = fixture.chunks.reduce(
    (sum, row) => sum + Buffer.byteLength(row.text),
    0
  );
  expect(baseline.counts).toEqual({
    reads: 5,
    rows: 3002,
    bytes: chunkBytes * 3 + Buffer.byteLength(fixture.content) * 2,
  });
  expect(candidate.counts).toEqual({
    reads: 2,
    rows: 1001,
    bytes: chunkBytes + Buffer.byteLength(fixture.content),
  });
  const stale = structuredClone(candidate.record);
  stale.deterministic.modelInputs[0]!.input = {
    query: "needle evidence",
    documents: ["stale shortened input"],
  };
  const negative = compareAcceptance(
    manifest("baseline"),
    manifest("candidate"),
    [baseline.record],
    [stale]
  );
  expect(negative.passed).toBe(false);
  expect(
    negative.failures.some((failure) => failure.field.includes("modelInputs"))
  ).toBe(true);
});

test.each(["release", "abort"] as const)(
  "%s relinquishes ownership while pending stages retain immutable results",
  async (ending) => {
    const deferred = Promise.withResolvers<void>();
    const rows = structuredClone(fixture.chunks.slice(0, 1));
    let reads = 0;
    const store = {
      getChunksBatch: async () => {
        reads++;
        await deferred.promise;
        return ok(new Map([[hash, rows]]));
      },
    } as unknown as StorePort;
    const controller = new AbortController();
    const owner = new RequestHydration(store, controller.signal);
    const a = owner.getChunksBatch([hash, hash]);
    const b = owner.getChunksBatch([hash]);
    if (ending === "abort") controller.abort();
    else owner.release();
    deferred.resolve();
    const [first, second] = await Promise.all([a, b]);
    expect(reads).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) throw new Error("Pending reads failed");
    const snapshot = first.value.get(hash)!;
    expect(snapshot).toBe(second.value.get(hash)!);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    const original = snapshot[0]!.text;
    rows[0]!.text = "mutated store object";
    first.value.clear();
    expect(second.value.get(hash)?.[0]?.text).toBe(original);
    expect((await owner.getChunksBatch([hash])).ok).toBe(false);
    owner.release();
    expect(reads).toBe(1);
  }
);

test.each(["missing", "error", "throw"] as const)(
  "%s cannot leak into a later request",
  async (initial) => {
    let state: string = initial;
    let reads = 0;
    const store = {
      getContent: async () => {
        reads++;
        if (state === "error") return err("QUERY_FAILED", "test failure");
        if (state === "throw") throw new Error("test rejection");
        return ok(state === "missing" ? null : state);
      },
    } as unknown as StorePort;
    const first = new RequestHydration(store);
    const pending = [first.getContent(hash), first.getContent(hash)];
    const observed = await Promise.allSettled(pending);
    expect(reads).toBe(1);
    if (initial === "throw")
      expect(observed.map((item) => item.status)).toEqual([
        "rejected",
        "rejected",
      ]);
    else
      expect(observed[0]).toMatchObject({
        status: "fulfilled",
        value:
          initial === "missing"
            ? ok(null)
            : err("QUERY_FAILED", "test failure"),
      });
    state = "fresh edited content";
    if (initial === "missing")
      expect(await first.getContent(hash)).toEqual(ok(null));
    else expect(await first.getContent(hash)).toEqual(ok(state));
    first.release();
    const next = new RequestHydration(store);
    expect(await next.getContent(hash)).toEqual(ok(state));
    next.release();
  }
);

test("document owners, collection filters and adapter order survive shared content hashes", async () => {
  let reads = 0;
  const rows = [
    {
      id: 1,
      collection: "a",
      title: "A",
      mirrorHash: hash,
      categories: ["original"],
    },
    { id: 2, collection: "b", title: "B", mirrorHash: "other" },
    { id: 3, collection: "b", title: "Duplicate owner", mirrorHash: hash },
  ] as DocumentRow[];
  const store = {
    getDocumentsByMirrorHashes: async (
      _hashes: string[],
      options?: { collection?: string; activeOnly?: boolean }
    ) => {
      reads++;
      return ok(
        rows.filter(
          (row) => !options?.collection || row.collection === options.collection
        )
      );
    },
  } as unknown as StorePort;
  const owner = new RequestHydration(store);
  const [first, repeated] = await Promise.all([
    owner.getDocumentsByMirrorHashes([hash, "other"]),
    owner.getDocumentsByMirrorHashes([hash, "other"]),
  ]);
  expect(reads).toBe(1);
  expect(first).toEqual(ok(rows));
  expect(repeated).toEqual(first);
  if (!(first.ok && repeated.ok)) throw new Error("Document read failed");
  expect(Object.isFrozen(first.value[0]?.categories)).toBe(true);
  first.value.pop();
  expect(repeated.value).toHaveLength(3);
  const scoped = await owner.getDocumentsByMirrorHashes([hash, "other"], {
    collection: "a",
  });
  expect(scoped).toEqual(ok([rows[0]!]));
  await owner.getDocumentsByMirrorHashes([hash, "other"], {
    collection: "a",
    activeOnly: false,
  });
  expect(reads).toBe(3);
  owner.release();
  rows[0]!.title = "Edited title";
  const next = new RequestHydration(store);
  const edited = await next.getDocumentsByMirrorHashes([hash, "other"]);
  expect(edited.ok && edited.value[0]?.title).toBe("Edited title");
  expect(repeated.value[0]?.title).toBe("A");
  next.release();
});
