import { afterAll, beforeAll, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type { HybridSearchOptions } from "../../src/pipeline/types";
import type { StorePort, TagRow } from "../../src/store/types";
import type { VectorSearchResult } from "../../src/store/vector/types";

import {
  eligibleTopKFixture,
  exhaustiveEligibleVectors,
} from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { evaluateRetrievalEligibility } from "../../src/pipeline/filters";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { err, ok } from "../../src/store/types";
import { buildEligibleVectorQuery } from "../../src/store/vector/eligibility";
import { createEligibleVectorFixture } from "../helpers/eligible-vector-fixture";

const fixture = eligibleTopKFixture();
const target = fixture[200]!;
const store = {
  getTagsForDoc: (id: number) =>
    Promise.resolve(ok((fixture[id - 1]?.tags ?? []).map((tag) => ({ tag })))),
} as StorePort;
const scope = { allowedMirrorHashes: [target.doc.mirrorHash!] };

test.each([1, 10])(
  "eligible vector oracle rejects global top-K at K=%i",
  async (limit) => {
    const eligible = new Set<string>();
    for (const item of fixture) {
      const result = await evaluateRetrievalEligibility(
        store,
        "needle",
        item.doc,
        item.chunks,
        { tagsAll: ["approved"], lang: "en" }
      );
      for (const chunk of result.chunks)
        eligible.add(`${item.doc.docid}:${chunk.seq}`);
    }
    expect([...eligible]).toEqual(["#fixture-200:1"]);
    const oracle = exhaustiveEligibleVectors(fixture, eligible, limit);
    expect(oracle).toEqual([
      { owner: "#fixture-200", seq: 1, distance: 0.19999999999999996 },
    ]);
    const all = new Set(
      fixture.flatMap(({ doc, chunks }) =>
        chunks.map((c) => `${doc.docid}:${c.seq}`)
      )
    );
    const overfetched = exhaustiveEligibleVectors(
      fixture,
      all,
      limit * 10
    ).filter((hit) => eligible.has(`${hit.owner}:${hit.seq}`));
    expect(overfetched).not.toEqual(oracle);
    expect(overfetched).toEqual([]);
  }
);

test.each([
  { tagsAll: ["approved", "release"] },
  { tagsAny: ["absent", "approved"] },
  { since: "2026-09-01", until: "2026-09-01" },
  { author: "ADA" },
  { categories: ["RELEASE"] },
  { categories: ["DECISION"] },
  { retrievalScope: { ...scope, relPathPrefix: "scope/target.md" } },
] satisfies HybridSearchOptions[])(
  "document eligibility preserves %j",
  async (options) => {
    const owners: string[] = [];
    for (const { doc, chunks } of fixture) {
      if (
        (
          await evaluateRetrievalEligibility(
            store,
            "needle",
            doc,
            chunks,
            options
          )
        ).matches
      )
        owners.push(doc.docid);
    }
    expect(owners).toEqual(["#fixture-200"]);
  }
);

test.each([
  { collection: "other" },
  { retrievalScope: { allowedMirrorHashes: [] } },
  { retrievalScope: { ...scope, relPathPrefix: "scop" } },
  { tagsAll: ["absent"] },
  { tagsAny: ["absent"] },
  { since: "2027-01-01" },
  { until: "2020-01-01" },
  { author: "nobody" },
  { categories: ["unknown"] },
  { lang: "fr" },
  { lang: "en", exclude: ["DEUTSCHE"] },
] satisfies HybridSearchOptions[])(
  "zero matches stays empty for %j",
  async (options) => {
    const result = await evaluateRetrievalEligibility(
      store,
      "needle",
      target.doc,
      target.chunks,
      options
    );
    expect(result.matches).toBe(false);
    expect(result.chunks).toEqual([]);
  }
);

test("caller scope intersects user scope and path uses original record path", async () => {
  for (const caller of [
    { collection: "other" },
    { retrievalScope: { allowedMirrorHashes: [] } },
    { retrievalScope: { ...scope, relPathPrefix: "elsewhere" } },
  ]) {
    expect(
      (
        await evaluateRetrievalEligibility(
          store,
          "needle",
          target.doc,
          target.chunks,
          { retrievalScope: scope },
          caller
        )
      ).matches
    ).toBe(false);
  }
  const doc = {
    ...target.doc,
    relPath: "synthetic/record",
    recordSourcePath: "scope/target.md",
  };
  expect(
    (
      await evaluateRetrievalEligibility(
        store,
        "needle",
        doc,
        target.chunks,
        { retrievalScope: { ...scope, relPathPrefix: "scope" } },
        { collection: "notes", retrievalScope: scope }
      )
    ).matches
  ).toBe(true);
});

test("metadata failures and inactive owners fail closed", async () => {
  for (const [doc, chunks] of [
    [undefined, target.chunks],
    [target.doc, undefined],
    [{ ...target.doc, active: false }, target.chunks],
    [target.doc, fixture[0]!.chunks],
  ] as const) {
    expect(
      (await evaluateRetrievalEligibility(store, "needle", doc, chunks, {}))
        .matches
    ).toBe(false);
  }
  for (const getTagsForDoc of [
    () => Promise.resolve(err<TagRow[]>("QUERY_FAILED", "fixture failure")),
    () => Promise.reject(new Error("fixture failure")),
  ]) {
    const failedStore: StorePort = { ...store, getTagsForDoc };
    const result = await evaluateRetrievalEligibility(
      failedStore,
      "needle",
      target.doc,
      target.chunks,
      { tagsAll: ["approved"] }
    );
    expect(result.matches).toBe(false);
    expect(result.chunks).toEqual([]);
  }
});

test("unvalidated dates retain existing ignored-bound semantics; exact language and empty tags", async () => {
  const result = await evaluateRetrievalEligibility(
    store,
    "needle",
    target.doc,
    target.chunks,
    { since: "not-a-date", tagsAll: [], tagsAny: [], lang: "en" }
  );
  expect(result.chunks.map((chunk) => chunk.seq)).toEqual([1]);
  expect(
    (
      await evaluateRetrievalEligibility(
        store,
        "needle",
        target.doc,
        target.chunks,
        { lang: "EN" }
      )
    ).matches
  ).toBe(false);
});

test("exhaustive ties are stable, duplicate owners retain distinct eligibility", () => {
  const pairs = new Set(["#fixture-0:0", "#fixture-1:0"]);
  const expected = exhaustiveEligibleVectors(fixture, pairs, 10);
  expect(expected.map((row) => row.owner)).toEqual([
    "#fixture-0",
    "#fixture-1",
  ]);
  expect(exhaustiveEligibleVectors([...fixture].reverse(), pairs, 10)).toEqual(
    expected
  );
  expect(exhaustiveEligibleVectors(fixture, new Set(), 10)).toEqual([]);
});

let live: Awaited<ReturnType<typeof createEligibleVectorFixture>>;
let adapter: typeof live.adapter;
let db: typeof live.db;
let vectorIndex: typeof live.vectorIndex;
beforeAll(async () => {
  live = await createEligibleVectorFixture();
  ({ adapter, db, vectorIndex } = live);
});
afterAll(async () => {
  await live?.close();
});

const vectorQuery = new Float32Array([1, 0]);
const config = {} as Config;
const embedPort: EmbeddingPort = {
  modelUri: "test",
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
};

test.each([1, 10])(
  "real sqlite-vec and public vector/hybrid calls find rare eligible chunk at K=%i",
  async (limit) => {
    const options = {
      limit,
      tagsAll: ["approved"],
      categories: ["RELEASE"],
      lang: "en",
      noExpand: true,
      noRerank: true,
      noGraph: true,
    };
    const nearest = await vectorIndex.searchNearest(vectorQuery, limit, {
      eligibility: { tagsAll: options.tagsAll, language: options.lang },
    });
    expect(nearest.ok).toBe(true);
    if (!nearest.ok) throw new Error(nearest.error.message);
    const oracle = exhaustiveEligibleVectors(
      fixture,
      new Set(["#fixture-200:1"]),
      limit
    );
    expect(nearest.value.map((hit) => [hit.mirrorHash, hit.seq])).toEqual([
      [target.doc.mirrorHash!, 1],
    ]);
    expect(nearest.value[0]!.distance).toBeCloseTo(oracle[0]!.distance, 6);
    const vector = await searchVectorWithEmbedding(
      { store: adapter, vectorIndex, config, embedPort },
      "needle",
      vectorQuery,
      options
    );
    expect(vector.ok).toBe(true);
    if (vector.ok)
      expect(
        vector.value.results.map((hit) => [hit.uri, hit.snippetLanguage])
      ).toEqual([[target.doc.uri, "en"]]);
    const hybrid = await searchHybrid(
      {
        store: adapter,
        config,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "needle",
      options
    );
    expect(hybrid.ok).toBe(true);
    if (hybrid.ok)
      expect(
        hybrid.value.results.map((hit) => [hit.uri, hit.snippetLanguage])
      ).toEqual([[target.doc.uri, "en"]]);
  }
);

test("real vector scope intersections, all-chunk exclusions and missing metadata fail closed", async () => {
  for (const options of [
    { allowedMirrorHashes: [], eligibility: {} },
    {
      allowedMirrorHashes: [target.doc.mirrorHash!],
      eligibility: { allowedMirrorHashes: [fixture[0]!.doc.mirrorHash!] },
    },
    { eligibility: { collection: "other" } },
    { eligibility: { author: "%" } },
    { eligibility: { author: "_" } },
    { eligibility: { language: "fr" } },
    {
      eligibility: {
        tagsAll: ["approved"],
        language: "en",
        exclude: ["DEUTSCHE"],
      },
    },
    {
      eligibility: {
        tagsAll: ["approved"],
        exclude: ["lovelace"],
        excludeMetadata: true,
      },
    },
  ]) {
    expect(await vectorIndex.searchNearest(vectorQuery, 10, options)).toEqual(
      ok([])
    );
  }
  db.query("UPDATE documents SET author = ? WHERE mirror_hash = ?").run(
    "Ümit_100%",
    target.doc.mirrorHash!
  );
  try {
    for (const author of ["üMIT", "_100%"])
      expect(
        await vectorIndex.searchNearest(vectorQuery, 1, {
          eligibility: { author, language: "en" },
        })
      ).toMatchObject({
        ok: true,
        value: [{ mirrorHash: target.doc.mirrorHash, seq: 1 }],
      });
  } finally {
    db.query("UPDATE documents SET author = ? WHERE mirror_hash = ?").run(
      target.doc.author!,
      target.doc.mirrorHash!
    );
  }
  db.exec("ALTER TABLE doc_tags RENAME TO unavailable_doc_tags");
  try {
    const result = await vectorIndex.searchNearest(vectorQuery, 1, {
      eligibility: { tagsAll: ["approved"] },
    });
    expect(result.ok).toBe(false);
  } finally {
    db.exec("ALTER TABLE unavailable_doc_tags RENAME TO doc_tags");
  }
});

test("hybrid lexical-only budget respects language and metadata exclusions", async () => {
  for (const limit of [1, 10]) {
    const result = await searchHybrid(
      {
        store: adapter,
        config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "needle",
      {
        limit,
        lang: "en",
        exclude: ["Noise Writer"],
        noExpand: true,
        noRerank: true,
        noGraph: true,
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.results.map((hit) => [hit.uri, hit.snippetLanguage])
      ).toEqual([[target.doc.uri, "en"]]);
  }
});

test("shared-mirror title owners retain independent exclusion", async () => {
  db.query("UPDATE documents SET title = ? WHERE rel_path = ?").run(
    "Denied owner",
    fixture[0]!.doc.relPath
  );
  try {
    const result = await searchVectorWithEmbedding(
      { store: adapter, vectorIndex, config, embedPort },
      "needle",
      vectorQuery,
      {
        limit: 1,
        lang: "en",
        exclude: ["Denied owner"],
        retrievalScope: { allowedMirrorHashes: [fixture[0]!.doc.mirrorHash!] },
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.results.map((hit) => hit.uri)).toEqual([
        fixture[1]!.doc.uri,
      ]);
  } finally {
    db.query("UPDATE documents SET title = ? WHERE rel_path = ?").run(
      fixture[0]!.doc.title!,
      fixture[0]!.doc.relPath
    );
  }
});

test("eligible exact distance ordering equals exhaustive SQLite and records query plan", async () => {
  const options = { eligibility: { language: "en" } };
  const eligible = buildEligibleVectorQuery(db, options);
  const sql = `SELECT v.mirror_hash AS mirrorHash, v.seq, vec_distance_cosine(v.embedding, ?) AS distance FROM content_vectors v WHERE v.model = ? AND EXISTS (${eligible.sql}) ORDER BY distance, v.mirror_hash, v.seq`;
  const params = [
    new Uint8Array(vectorQuery.buffer),
    vectorIndex.model,
    ...eligible.params,
  ];
  const exhaustive = db
    .query<VectorSearchResult, (Uint8Array | string | number)[]>(sql)
    .all(...params);
  for (const limit of [1, 10, 201, 300]) {
    expect(
      await vectorIndex.searchNearest(vectorQuery, limit, options)
    ).toEqual(ok(exhaustive.slice(0, limit)));
  }
  expect(
    db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params).length
  ).toBeGreaterThan(0);
});
