import { afterAll, beforeAll, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { MetadataPredicate } from "../../src/core/typed-metadata";
import type { EmbeddingPort } from "../../src/llm/types";
import type { StorePort } from "../../src/store/types";

import { eligibleTopKFixture } from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { typedMetadataFilterReason } from "../../src/pipeline/filters";
import { expandGraphCandidates } from "../../src/pipeline/graph-retrieval";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { createEligibleVectorFixture } from "../helpers/eligible-vector-fixture";

const fixture = eligibleTopKFixture();
const target = fixture[200]!;
const filter: MetadataPredicate = { op: "eq", key: "approved", value: true };
let live: Awaited<ReturnType<typeof createEligibleVectorFixture>>;
const embedPort: EmbeddingPort = {
  modelUri: "test",
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
};
beforeAll(async () => {
  live = await createEligibleVectorFixture();
  live.db.exec(
    "UPDATE documents SET ingest_version = 7, typed_metadata = '{\"approved\":false}'"
  );
  live.db
    .query("UPDATE documents SET typed_metadata = ? WHERE rel_path = ?")
    .run(JSON.stringify({ approved: true }), target.doc.relPath);
});
afterAll(async () => {
  await live?.close();
});

function deps() {
  return {
    store: live.adapter,
    vectorIndex: live.vectorIndex,
    embedPort,
    config: {} as Config,
    expandPort: null,
    rerankPort: null,
  };
}

test.each([1, 10])(
  "rare typed match survives FTS/vector/hybrid candidate limits K=%i",
  async (limit) => {
    const options = {
      limit,
      filter,
      lang: "en",
      noExpand: true,
      noRerank: true,
      noGraph: true,
    };
    for (const result of [
      await searchBm25(live.adapter, "needle", options),
      await searchVectorWithEmbedding(
        deps(),
        "needle",
        new Float32Array([1, 0]),
        options
      ),
      await searchHybrid(deps(), "needle", options),
    ]) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.results.map((hit) => hit.uri)).toEqual([
        target.doc.uri,
      ]);
      expect(result.value.meta.warnings).toBeUndefined();
    }
  }
);

test("typed owner eligibility does not borrow metadata from identical content", async () => {
  const owner = fixture[1]!;
  live.db
    .query("UPDATE documents SET typed_metadata = ? WHERE rel_path = ?")
    .run(JSON.stringify({ approved: true }), owner.doc.relPath);
  try {
    const result = await searchVectorWithEmbedding(
      deps(),
      "needle",
      new Float32Array([1, 0]),
      {
        limit: 1,
        filter,
        lang: "en",
        retrievalScope: { allowedMirrorHashes: [owner.doc.mirrorHash!] },
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.results.map((hit) => hit.uri)).toEqual([
        owner.doc.uri,
      ]);
  } finally {
    live.db
      .query("UPDATE documents SET typed_metadata = ? WHERE rel_path = ?")
      .run(JSON.stringify({ approved: false }), owner.doc.relPath);
  }
});

test("unfiltered results survive invalid metadata; filtered coverage is scope-limited", async () => {
  const before = await searchBm25(live.adapter, "needle", { limit: 5 });
  live.db
    .query(
      "UPDATE documents SET metadata_error = 'invalid namespace' WHERE rel_path = ?"
    )
    .run(target.doc.relPath);
  try {
    expect(await searchBm25(live.adapter, "needle", { limit: 5 })).toEqual(
      before
    );
    const result = await searchBm25(live.adapter, "needle", { filter });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results).toEqual([]);
      expect(result.value.meta.warnings?.[0]?.code).toBe(
        "METADATA_COVERAGE_INCOMPLETE"
      );
    }
    const scoped = await searchBm25(live.adapter, "needle", {
      filter,
      collection: "other",
    });
    if (scoped.ok) expect(scoped.value.meta.warnings).toBeUndefined();
  } finally {
    live.db
      .query("UPDATE documents SET metadata_error = NULL WHERE rel_path = ?")
      .run(target.doc.relPath);
  }
});

test("negation never makes invalid or unextracted metadata eligible", () => {
  const negative: MetadataPredicate = { op: "not", predicate: filter };
  expect(
    typedMetadataFilterReason(
      { ...target.doc, ingestVersion: 6, typedMetadata: {} },
      negative
    )
  ).toBe("metadata_backfill");
  expect(
    typedMetadataFilterReason(
      {
        ...target.doc,
        ingestVersion: 7,
        typedMetadata: {},
        metadataError: "bad",
      },
      negative
    )
  ).toBe("metadata_invalid");
  expect(
    typedMetadataFilterReason(
      { ...target.doc, ingestVersion: 7, typedMetadata: {} },
      negative
    )
  ).toBeUndefined();
});

test("invalid direct pipeline predicates fail before any retrieval", async () => {
  const invalid = {
    op: "gt",
    key: "score",
    value: "10",
  } as unknown as MetadataPredicate;
  const outcomes = await Promise.allSettled([
    searchBm25(live.adapter, "needle", { filter: invalid }),
    searchHybrid(deps(), "needle", { filter: invalid }),
    searchVectorWithEmbedding(deps(), "needle", new Float32Array([1, 0]), {
      filter: invalid,
    }),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
  ]);
});

test("graph applies typed and caller eligibility before its candidate budget", async () => {
  const seed = fixture[50]!;
  const denied = fixture[60]!;
  const seedRows = await live.adapter.getDocumentsByMirrorHashes([
    seed.doc.mirrorHash!,
  ]);
  const targetRows = await live.adapter.getDocumentsByMirrorHashes([
    target.doc.mirrorHash!,
  ]);
  const deniedRows = await live.adapter.getDocumentsByMirrorHashes([
    denied.doc.mirrorHash!,
  ]);
  if (!seedRows.ok || !targetRows.ok || !deniedRows.ok)
    throw new Error("Fixture read failed");
  const seedDoc = seedRows.value[0]!;
  const targetDoc = targetRows.value[0]!;
  const deniedDoc = deniedRows.value[0]!;
  const store = {
    getDocumentsByMirrorHashes: live.adapter.getDocumentsByMirrorHashes.bind(
      live.adapter
    ),
    getDocumentsByDocids: live.adapter.getDocumentsByDocids.bind(live.adapter),
    getChunksBatch: live.adapter.getChunksBatch.bind(live.adapter),
    getGraphNeighborsForSeeds: async ({
      seedDocumentIds,
    }: {
      seedDocumentIds: number[];
    }) => ({
      ok: true as const,
      value: {
        links: [deniedDoc, targetDoc].map((doc, index) => ({
          source: seedDoc.docid,
          target: doc.docid,
          type: "wiki",
          confidence: "explicit",
          weight: 10 - index,
        })),
        meta: { seedDocumentIds, examinedLinkRows: 2, returnedEdges: 2 },
      },
    }),
  } as StorePort;
  const result = await expandGraphCandidates(
    store,
    [
      {
        mirrorHash: seed.doc.mirrorHash!,
        seq: 0,
        bm25Rank: 1,
        vecRank: null,
        fusionScore: 1,
        sources: ["bm25"],
      },
    ],
    {
      candidateLimit: 1,
      eligibility: {
        collection: "notes",
        filter,
        allowedMirrorHashes: [target.doc.mirrorHash!],
      },
    }
  );
  expect(result.candidates).toEqual([
    { mirrorHash: target.doc.mirrorHash!, seq: 0 },
  ]);
});
