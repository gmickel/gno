import { describe, expect, test } from "bun:test";

import type { ContentTypeBoostPromotionArtifact } from "../../evals/agentic/content-type-boost-promotion";
import type { ProjectAffinityPromotionArtifact } from "../../evals/agentic/project-affinity-promotion";
import type { NormalizedContentTypeRule } from "../../src/config/content-types";
import type { ProjectAffinityResolution } from "../../src/core/project-affinity";
import type { SearchResult } from "../../src/pipeline/types";
import type { ChunkRow, FtsResult, StorePort } from "../../src/store/types";

import { buildContentTypeBoostPromotion } from "../../evals/agentic/content-type-boost-promotion";
import committed from "../../evals/fixtures/agentic-retrieval/baseline/fixture-agent/content-type-boost-promotion.json";
import source from "../../evals/fixtures/agentic-retrieval/baseline/fixture-agent/project-affinity-promotion.json";
import {
  applyContentTypeBoost,
  getContentTypeBoostMetadata,
  sortByFinalScoreStable,
} from "../../src/pipeline/content-type-boost";
import { searchBm25 } from "../../src/pipeline/search";

const rules: NormalizedContentTypeRule[] = [
  {
    id: "decision",
    preset: "decision-note",
    prefixes: ["decisions/"],
    searchBoost: 2,
  },
  {
    id: "archive",
    preset: "blank",
    prefixes: ["archive/"],
    searchBoost: 0.5,
  },
];

const affinity: ProjectAffinityResolution = {
  matches: [
    {
      collection: "notes",
      collectionAlias: "collection_000000000000",
      distance: 0,
      relation: "exact",
      rootAlias: "root_000000000000",
      source: "cli_cwd",
    },
  ],
  roots: [],
};

const result = (
  relPath: string,
  score: number,
  contentType?: string,
  collection = "notes"
): SearchResult => ({
  docid: `#${relPath}`,
  score,
  uri: `gno://${collection}/${relPath}`,
  contentType,
  snippet: "evidence",
  source: { relPath, mime: "text/markdown", ext: ".md" },
});

describe("content-type search boost adversarial promotion gates", () => {
  test("promotes relevant typed evidence but cannot overcome a clear relevance lead", () => {
    const relevant = result("decisions/launch.md", 0.7, "decision");
    const close = result("notes/close.md", 0.69);
    const strong = result("notes/strong.md", 0.95);
    const stuffed = result("decisions/keyword-stuffed.md", 0.4, "decision");

    for (const candidate of [relevant, close, strong, stuffed]) {
      applyContentTypeBoost(candidate, "notes", rules, undefined);
    }
    const promoted = [close, relevant];
    sortByFinalScoreStable(promoted);
    expect(promoted.map((candidate) => candidate.source.relPath)).toEqual([
      "decisions/launch.md",
      "notes/close.md",
    ]);

    const guarded = [stuffed, strong];
    sortByFinalScoreStable(guarded);
    expect(guarded.map((candidate) => candidate.source.relPath)).toEqual([
      "notes/strong.md",
      "decisions/keyword-stuffed.md",
    ]);
    expect(stuffed.score).toBeCloseTo(0.45);
  });

  test("keeps ties stable and configured metadata wins over a conflicting prefix", () => {
    const boosted = result("decisions/first.md", 0.5, "decision");
    const neutral = result("notes/second.md", 0.55);
    applyContentTypeBoost(boosted, "notes", rules, undefined);
    const tied = [boosted, neutral];
    sortByFinalScoreStable(tied);
    expect(tied.map((candidate) => candidate.source.relPath)).toEqual([
      "decisions/first.md",
      "notes/second.md",
    ]);

    const conflicting = result(
      "decisions/configured-archive.md",
      0.7,
      "archive"
    );
    applyContentTypeBoost(conflicting, "notes", rules, undefined);
    expect(conflicting.score).toBeCloseTo(0.65);
    expect(getContentTypeBoostMetadata(conflicting)).toMatchObject({
      contentType: "archive",
      ruleSource: "configured-id",
      cappedContribution: -0.05,
    });
  });

  test("composes with affinity only once under the shared auxiliary cap", () => {
    const candidate = result("decisions/combined.md", 0.5, "decision");
    applyContentTypeBoost(candidate, "notes", rules, {
      resolution: affinity,
      contribution: 0.08,
    });
    expect(getContentTypeBoostMetadata(candidate)).toMatchObject({
      rawContribution: 0.05,
      combinedAuxiliaryRequested: 0.08,
      combinedAuxiliaryApplied: 0.08,
      finalScore: 0.58,
    });
  });

  test("cannot create candidates or bypass collection and exclude filters", async () => {
    const rows: FtsResult[] = [
      {
        docid: "#allowed",
        uri: "gno://notes/decisions/allowed.md",
        relPath: "decisions/allowed.md",
        collection: "notes",
        mirrorHash: "allowed",
        seq: 0,
        score: -10,
        contentType: "decision",
      },
      {
        docid: "#excluded",
        uri: "gno://notes/decisions/excluded.md",
        relPath: "decisions/excluded.md",
        collection: "notes",
        mirrorHash: "excluded",
        seq: 0,
        score: -9,
        contentType: "decision",
      },
    ];
    const chunks = new Map<string, ChunkRow[]>([
      ["allowed", [chunk("allowed", "launch evidence")]],
      ["excluded", [chunk("excluded", "staging keyword stuffing")]],
    ]);
    const store: Partial<StorePort> = {
      searchFts: async (_query, options) => ({
        ok: true as const,
        value: options?.collection === "notes" ? rows : [],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: [
          {
            name: "notes",
            path: "/redacted/notes",
            pattern: "**/*",
            include: null,
            exclude: null,
            updateCmd: null,
            languageHint: null,
            syncedAt: "2026-07-22T00:00:00.000Z",
          },
        ],
      }),
      getChunksBatch: async () => ({ ok: true as const, value: chunks }),
    };

    const searched = await searchBm25(store as StorePort, "launch", {
      collection: "notes",
      contentTypeRules: rules,
      exclude: ["staging"],
      limit: 10,
    });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.value.results.map((candidate) => candidate.docid)).toEqual([
      "#allowed",
    ]);
  });

  test("commits exact fn-97 before/after receipts with no accuracy or coverage loss", () => {
    const rebuilt = buildContentTypeBoostPromotion(
      source as ProjectAffinityPromotionArtifact
    );
    expect(rebuilt).toEqual(committed as ContentTypeBoostPromotionArtifact);
    expect(rebuilt.gates).toEqual({
      passed: true,
      failures: [],
      exactNoOpReceipts: true,
      evidenceAccuracyLoss: 0,
      evidenceCoverageLoss: 0,
    });
    expect(rebuilt.receipts).toHaveLength(24);
  });
});

function chunk(mirrorHash: string, text: string): ChunkRow {
  return {
    mirrorHash,
    seq: 0,
    pos: 0,
    text,
    startLine: 1,
    endLine: 1,
    language: "en",
    tokenCount: 2,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}
