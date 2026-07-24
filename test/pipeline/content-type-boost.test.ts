import { describe, expect, test } from "bun:test";

import type { NormalizedContentTypeRule } from "../../src/config";
import type { ProjectAffinityResolution } from "../../src/core/project-affinity";
import type { SearchResult } from "../../src/pipeline/types";
import type {
  ChunkRow,
  CollectionRow,
  FtsResult,
  StorePort,
} from "../../src/store/types";

import {
  applyContentTypeBoost,
  contentTypeBoostContribution,
  getContentTypeBoostMetadata,
  scoreContentTypeBoost,
  sortByFinalScoreStable,
} from "../../src/pipeline/content-type-boost";
import { formatResultExplain } from "../../src/pipeline/explain";
import { getProjectAffinityMetadata } from "../../src/pipeline/project-affinity";
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
  {
    id: "neutral",
    preset: "blank",
    prefixes: ["notes/"],
    searchBoost: 1,
  },
];

const affinityResolution: ProjectAffinityResolution = {
  matches: [
    {
      collection: "project",
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
  score: number,
  contentType?: string,
  relPath = "doc.md"
): SearchResult => ({
  docid: `#${relPath}`,
  score,
  uri: `gno://project/${relPath}`,
  contentType,
  snippet: "evidence",
  source: {
    relPath,
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

const fts = (
  docid: string,
  score: number,
  contentType: string,
  collection = "project"
): FtsResult => ({
  docid,
  uri: `gno://${collection}/${docid.slice(1)}.md`,
  relPath: `${docid.slice(1)}.md`,
  collection,
  mirrorHash: docid.slice(1),
  seq: 0,
  score,
  contentType,
});

const collections: CollectionRow[] = [
  {
    name: "project",
    path: "/redacted/project",
    pattern: "**/*",
    include: null,
    exclude: null,
    updateCmd: null,
    languageHint: null,
    syncedAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("bounded content-type scoring", () => {
  test("maps factors monotonically onto the bounded contribution", () => {
    expect(contentTypeBoostContribution(0.5)).toEqual({
      raw: -0.05,
      capped: -0.05,
    });
    expect(contentTypeBoostContribution(1)).toEqual({ raw: 0, capped: 0 });
    expect(contentTypeBoostContribution(1.5).raw).toBeCloseTo(0.025);
    expect(contentTypeBoostContribution(2)).toEqual({
      raw: 0.05,
      capped: 0.05,
    });
    expect(contentTypeBoostContribution(10).capped).toBe(0.05);
    expect(contentTypeBoostContribution(-10).capped).toBe(-0.05);
  });

  test("composes once with affinity under the shared auxiliary cap", () => {
    const scored = scoreContentTypeBoost(
      0.5,
      "decision",
      "frontmatter-type",
      "other.md",
      "project",
      rules,
      { resolution: affinityResolution },
      { kind: "hybrid_blended", score: 0.5 }
    );

    expect(scored.contentTypeBoost).toMatchObject({
      baseScore: 0.5,
      configuredFactor: 2,
      rawContribution: 0.05,
      cappedContribution: 0.05,
      combinedAuxiliaryRequested: 0.08,
      combinedAuxiliaryApplied: 0.08,
      finalScore: 0.58,
      ruleSource: "configured-id",
    });
    expect(scored.projectAffinity).toMatchObject({
      affinityRequested: 0.03,
      combinedAuxiliaryRequested: 0.08,
      finalScore: 0.58,
    });
  });

  test("resolves configured type before prefix and leaves neutral cases exact", () => {
    const configured = applyContentTypeBoost(
      result(0.6, "archive", "decisions/record.md"),
      "project",
      rules,
      undefined,
      "frontmatter-type"
    );
    expect(configured.score).toBeCloseTo(0.55);
    expect(getContentTypeBoostMetadata(configured)?.ruleSource).toBe(
      "configured-id"
    );

    for (const input of [
      result(0.6, "neutral", "notes/note.md"),
      result(0.6, "unknown", "misc/note.md"),
    ]) {
      const returned = applyContentTypeBoost(
        input,
        "project",
        rules,
        undefined,
        "frontmatter-type"
      );
      expect(returned).toBe(input);
      expect(returned.score).toBe(0.6);
      expect(getContentTypeBoostMetadata(returned)).toBeUndefined();
    }
  });

  test("does not treat an inferred built-in type as a configured rule id", () => {
    const overlappingRules: NormalizedContentTypeRule[] = [
      {
        id: "code",
        preset: "blank",
        prefixes: ["important/"],
        searchBoost: 2,
      },
    ];
    const inferred = result(0.5, "code", "src/foo.ts");
    const prefixed = result(0.5, "code", "important/foo.ts");

    applyContentTypeBoost(
      inferred,
      "project",
      overlappingRules,
      undefined,
      "path-ext"
    );
    applyContentTypeBoost(
      prefixed,
      "project",
      overlappingRules,
      undefined,
      "path-ext"
    );

    expect(inferred.score).toBe(0.5);
    expect(getContentTypeBoostMetadata(inferred)).toBeUndefined();
    expect(getContentTypeBoostMetadata(prefixed)).toMatchObject({
      contentType: "code",
      ruleSource: "prefix",
      finalScore: 0.55,
    });
  });

  test("keeps metadata internal while explain exposes score composition", () => {
    const boosted = applyContentTypeBoost(
      result(0.5, "decision"),
      "project",
      rules,
      { resolution: affinityResolution },
      "frontmatter-type",
      { kind: "bm25", score: -7 }
    );
    const contentTypeBoost = getContentTypeBoostMetadata(boosted);
    const projectAffinity = getProjectAffinityMetadata(boosted);

    expect(JSON.stringify(boosted)).not.toContain("configuredFactor");
    const explain = formatResultExplain([
      {
        rank: 1,
        docid: boosted.docid,
        score: boosted.score,
        contentTypeBoost,
        projectAffinity,
      },
    ]);
    expect(explain).toContain("factor=2.000");
    expect(explain).toContain("rawBoost=0.050");
    expect(explain).toContain("auxiliary=0.080/0.080");
    expect(explain).toContain("final=0.580");
  });

  test("preserves retrieval order when final scores tie", () => {
    const first = result(0.5, "decision", "first.md");
    const second = result(0.55, "neutral", "second.md");
    applyContentTypeBoost(
      first,
      "project",
      rules,
      undefined,
      "frontmatter-type"
    );
    const tied = [first, second];
    sortByFinalScoreStable(tied);
    expect(tied.map((entry) => entry.source.relPath)).toEqual([
      "first.md",
      "second.md",
    ]);
  });

  test("BM25 scores after normalization without creating or rescuing candidates", async () => {
    let requestedLimit: number | undefined;
    const rows = [
      fts("#strong00", -100, "neutral"),
      fts("#boosted0", -80, "decision"),
      fts("#demoted0", 0, "archive"),
    ];
    const store: Partial<StorePort> = {
      searchFts: async (_query, options) => {
        requestedLimit = options?.limit;
        return { ok: true as const, value: rows.slice(0, options?.limit) };
      },
      getCollections: async () => ({ ok: true as const, value: collections }),
      getChunksBatch: async (hashes) => ({
        ok: true as const,
        value: new Map(hashes.map((hash) => [hash, [chunk(hash)]])),
      }),
    };

    const searched = await searchBm25(store as StorePort, "query", {
      contentTypeRules: rules,
      limit: 1,
      minScore: 0.9,
    });

    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(requestedLimit).toBe(1);
    expect(searched.value.results.map((entry) => entry.docid)).toEqual([
      "#strong00",
    ]);
    expect(searched.value.results[0]?.score).toBe(1);
  });
});
