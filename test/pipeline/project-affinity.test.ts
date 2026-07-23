import { describe, expect, test } from "bun:test";

import type { ProjectAffinityResolution } from "../../src/core/project-affinity";
import type { SearchResult } from "../../src/pipeline/types";
import type {
  ChunkRow,
  CollectionRow,
  FtsResult,
  StorePort,
} from "../../src/store/types";

import {
  applyAuxiliaryScore,
  applyProjectAffinity,
  getProjectAffinityMetadata,
  scoreProjectAffinity,
} from "../../src/pipeline/project-affinity";
import { searchBm25 } from "../../src/pipeline/search";

const resolution = (
  collections: string[] = ["project"]
): ProjectAffinityResolution => ({
  matches: collections.map((collection) => ({
    collection,
    collectionAlias: `collection_${collection.padEnd(12, "0").slice(0, 12)}`,
    distance: 0,
    relation: "exact",
    rootAlias: "root_000000000000",
    source: "cli_cwd",
  })),
  roots: [],
});

const result = (score: number): SearchResult => ({
  docid: "#abcdef12",
  score,
  uri: "gno://project/doc.md",
  snippet: "evidence",
  source: {
    relPath: "doc.md",
    mime: "text/markdown",
    ext: ".md",
  },
});

const chunk = (mirrorHash: string): ChunkRow => ({
  mirrorHash,
  seq: 0,
  pos: 0,
  text: mirrorHash,
  startLine: 1,
  endLine: 1,
  language: "en",
  tokenCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const fts = (docid: string, collection: string, score: number): FtsResult => ({
  docid,
  uri: `gno://${collection}/${docid.slice(1)}.md`,
  relPath: `${docid.slice(1)}.md`,
  collection,
  mirrorHash: docid.slice(1),
  seq: 0,
  score,
});

const collections: CollectionRow[] = ["other", "project"].map((name) => ({
  name,
  path: `/redacted/${name}`,
  pattern: "**/*",
  include: null,
  exclude: null,
  updateCmd: null,
  languageHint: null,
  syncedAt: "2026-01-01T00:00:00.000Z",
}));

describe("bounded project affinity scoring", () => {
  test("composes auxiliary signals deterministically within the shared cap", () => {
    expect(applyAuxiliaryScore(0.5, [0.03, 0.05])).toEqual({
      requested: 0.08,
      applied: 0.08,
      finalScore: 0.58,
    });
    expect(applyAuxiliaryScore(0.5, [0.05, 0.03])).toEqual({
      requested: 0.08,
      applied: 0.08,
      finalScore: 0.58,
    });
    expect(applyAuxiliaryScore(0.5, [0.08, 0.03]).applied).toBe(0.08);
    expect(applyAuxiliaryScore(0.5, [-0.08, -0.05]).applied).toBe(-0.08);
  });

  test("applies one 0.03 contribution and shrinks only at saturation", () => {
    const normal = scoreProjectAffinity(0.7, "project", {
      resolution: resolution(),
    });
    expect(normal.affinityRequested).toBe(0.03);
    expect(normal.affinityApplied).toBeCloseTo(0.03);
    expect(normal.finalScore).toBeCloseTo(0.73);

    const saturated = scoreProjectAffinity(0.99, "project", {
      resolution: resolution(),
    });
    expect(saturated.affinityRequested).toBe(0.03);
    expect(saturated.affinityApplied).toBeCloseTo(0.01);
    expect(saturated.finalScore).toBe(1);
  });

  test("overlap never stacks and a larger base lead remains ahead", () => {
    const overlapping = {
      resolution: resolution(["project", "project"]),
    };
    expect(
      scoreProjectAffinity(0.5, "project", overlapping).finalScore
    ).toBeCloseTo(0.53);
    expect(
      scoreProjectAffinity(0.5, "project", overlapping).affinityRequested
    ).toBe(0.03);

    const preferred = scoreProjectAffinity(
      0.5,
      "project",
      overlapping
    ).finalScore;
    const stronger = scoreProjectAffinity(
      0.531,
      "other",
      overlapping
    ).finalScore;
    expect(stronger).toBeGreaterThan(preferred);
  });

  test("disabled, missing, untrusted, and unmatched inputs are exact no-ops", () => {
    const cases = [
      undefined,
      { enabled: false, resolution: resolution() },
      { resolution: resolution([]) },
      {
        resolution: {
          matches: [],
          roots: [
            {
              collectionAliases: [],
              reason: "untrusted_remote_hint" as const,
              repositoryRootDiscovered: false,
              rootAlias: "root_000000000000",
              source: "remote_hint" as const,
              status: "zero" as const,
            },
          ],
        },
      },
    ];

    for (const input of cases) {
      const searchResult = result(0.5);
      const returned = applyProjectAffinity(searchResult, "project", input);
      expect(returned).toBe(searchResult);
      expect(returned.score).toBe(0.5);
      expect(getProjectAffinityMetadata(returned)).toBeUndefined();
    }
  });

  test("keeps redacted scoring metadata hidden from public JSON", () => {
    const searchResult = applyProjectAffinity(result(0.5), "project", {
      resolution: resolution(),
    });
    const metadata = getProjectAffinityMetadata(searchResult);
    expect(metadata?.collectionAlias).toStartWith("collection_");
    expect(metadata?.rootAlias).toStartWith("root_");
    expect(metadata?.source).toBe("cli_cwd");
    expect(metadata?.baseScore).toBe(0.5);
    expect(metadata?.combinedAuxiliaryCap).toBe(0.08);
    expect(metadata?.combinedAuxiliaryRequested).toBe(0.03);
    expect(metadata?.finalScore).toBeCloseTo(0.53);
    expect(metadata?.rawScore).toBe(0.5);
    expect(metadata?.rawScoreKind).toBe("normalized");
    expect(JSON.stringify(searchResult)).not.toContain("affinity");
    expect(JSON.stringify(searchResult)).not.toContain("root_");
  });

  test("BM25 applies affinity after normalization without bypassing filters", async () => {
    const rows = [
      fts("#best0000", "other", -101),
      fts("#shared00", "other", -3),
      fts("#shared00", "project", -1),
    ];
    const store: Partial<StorePort> = {
      searchFts: async (_query, options) => ({
        ok: true as const,
        value: options?.collection
          ? rows.filter((row) => row.collection === options.collection)
          : rows,
      }),
      getCollections: async () => ({ ok: true as const, value: collections }),
      getChunksBatch: async (hashes) => ({
        ok: true as const,
        value: new Map(hashes.map((hash) => [hash, [chunk(hash)]])),
      }),
    };

    const boosted = await searchBm25(store as StorePort, "query", {
      limit: 3,
      projectAffinity: { resolution: resolution() },
    });
    expect(boosted.ok).toBe(true);
    if (!boosted.ok) return;
    expect(boosted.value.results.map((entry) => entry.uri)).toEqual([
      "gno://other/best0000.md",
      "gno://project/shared00.md",
      "gno://other/shared00.md",
    ]);
    expect(boosted.value.results[1]?.score).toBeCloseTo(0.03);
    expect(boosted.value.results[2]?.score).toBeCloseTo(0.02);
    expect(getProjectAffinityMetadata(boosted.value.results[1]!)).toMatchObject(
      {
        baseScore: 0,
        rawScore: -1,
        rawScoreKind: "bm25",
      }
    );
    expect(getProjectAffinityMetadata(boosted.value.results[2]!)).toMatchObject(
      {
        affinityApplied: 0,
        matched: false,
        rawScore: -3,
        rawScoreKind: "bm25",
      }
    );

    const filtered = await searchBm25(store as StorePort, "query", {
      collection: "other",
      limit: 3,
      projectAffinity: { resolution: resolution() },
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(
      filtered.value.results.every((entry) =>
        entry.uri.startsWith("gno://other")
      )
    ).toBe(true);
  });

  test("BM25 oversamples a bounded pool before affinity reorders output", async () => {
    let requestedLimit: number | undefined;
    const rows = [
      fts("#best0000", "other", -100),
      fts("#second00", "other", -51),
      fts("#project0", "project", -50),
      fts("#fourth00", "other", -25),
      fts("#fifth000", "other", -10),
      fts("#sixth000", "other", 0),
    ];
    const store: Partial<StorePort> = {
      searchFts: async (_query, options) => {
        requestedLimit = options?.limit;
        return {
          ok: true as const,
          value: rows.slice(0, options?.limit),
        };
      },
      getCollections: async () => ({ ok: true as const, value: collections }),
      getChunksBatch: async (hashes) => ({
        ok: true as const,
        value: new Map(hashes.map((hash) => [hash, [chunk(hash)]])),
      }),
    };

    const boosted = await searchBm25(store as StorePort, "query", {
      limit: 2,
      projectAffinity: { resolution: resolution() },
    });

    expect(boosted.ok).toBe(true);
    if (!boosted.ok) return;
    expect(requestedLimit).toBe(6);
    expect(boosted.value.results.map((entry) => entry.docid)).toEqual([
      "#best0000",
      "#project0",
    ]);
  });

  test("BM25 full mode scores collection copies before docid deduplication", async () => {
    const sharedHash = "shared-copy";
    const rows: FtsResult[] = [
      fts("#best0000", "other", -20),
      {
        ...fts("#shared00", "other", -10),
        mirrorHash: sharedHash,
        uri: "gno://other/shared.md",
        relPath: "shared.md",
      },
      {
        ...fts("#shared00", "project", -9.8),
        mirrorHash: sharedHash,
        uri: "gno://project/shared.md",
        relPath: "shared.md",
      },
      fts("#worst000", "other", 0),
    ];
    const store: Partial<StorePort> = {
      searchFts: async () => ({ ok: true as const, value: rows }),
      getCollections: async () => ({ ok: true as const, value: collections }),
      getChunksBatch: async (hashes) => ({
        ok: true as const,
        value: new Map(hashes.map((hash) => [hash, [chunk(hash)]])),
      }),
      getContentBatch: async (hashes) => ({
        ok: true as const,
        value: new Map(hashes.map((hash) => [hash, `Full ${hash}`])),
      }),
    };

    const boosted = await searchBm25(store as StorePort, "query", {
      full: true,
      limit: 4,
      projectAffinity: { resolution: resolution() },
    });

    expect(boosted.ok).toBe(true);
    if (!boosted.ok) return;
    const shared = boosted.value.results.filter(
      (entry) => entry.docid === "#shared00"
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]?.uri).toBe("gno://project/shared.md");
    expect(getProjectAffinityMetadata(shared[0]!)).toMatchObject({
      matched: true,
      collectionAlias: "collection_project00000",
    });
  });
});
