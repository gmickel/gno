import { expect, test } from "bun:test";

import type { HybridSearchOptions } from "../../src/pipeline/types";
import type { StorePort, TagRow } from "../../src/store/types";

import {
  eligibleTopKFixture,
  exhaustiveEligibleVectors,
} from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { evaluateRetrievalEligibility } from "../../src/pipeline/filters";
import { err, ok } from "../../src/store/types";

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
