import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("query-diagnose schema", () => {
  let schema: object;
  let legacySchema: object;

  beforeAll(async () => {
    schema = await loadSchema("query-diagnose");
    legacySchema = await loadSchema("query-diagnose-v1");
  });

  test("validates diagnosed response", () => {
    const response = {
      schemaVersion: "1.0",
      query: "alice acme",
      target: {
        ref: "gno://notes/alice.md",
        status: "diagnosed",
        docid: "#abcdef12",
        uri: "gno://notes/alice.md",
        title: "Alice",
        contentType: "person",
        contentTypeSource: "frontmatter",
        categories: ["people"],
        graphHints: ["works_at"],
        contentTypeRulesFingerprint: "abc",
        contentTypeFingerprintMatches: true,
        mirrorHash: "mirror-a",
        chunkCount: 1,
        filterReasons: [],
      },
      stages: [
        {
          id: "bm25",
          status: "active",
          sourceCount: 1,
          present: true,
          rank: 1,
          score: -4.2,
          survived: true,
          dropReason: null,
        },
        {
          id: "vector",
          status: "skipped",
          sourceCount: 0,
          present: false,
          rank: null,
          score: null,
          survived: false,
          dropReason: "skipped",
          reason: "vector_unavailable",
        },
      ],
      chunk: {
        seq: 1,
        startLine: 3,
        endLine: 8,
        language: "en",
      },
      meta: {
        mode: "bm25_only",
        vectorsUsed: false,
        reranked: false,
        totalResults: 1,
      },
    };
    const affinityResponse = {
      ...response,
      schemaVersion: "1.1",
      affinity: {
        affinityAdjustedScore: 0.53,
        affinityApplied: 0.03,
        affinityRequested: 0.03,
        affinityWeight: 0.03,
        baseScore: 0.5,
        collectionAlias: "collection_000000000000",
        combinedAuxiliaryApplied: 0.03,
        combinedAuxiliaryCap: 0.08,
        combinedAuxiliaryRequested: 0.03,
        finalBlendedScore: 0.53,
        finalScore: 0.53,
        matched: true,
        rawScore: 0.5,
        rawScoreKind: "hybrid_blended",
        rootAlias: "root_000000000000",
        source: "project_profile",
      },
    };

    expect(assertValid(response, schema)).toBe(true);
    expect(assertValid(response, legacySchema)).toBe(true);
    expect(assertValid(affinityResponse, schema)).toBe(true);
    expect(assertInvalid(affinityResponse, legacySchema)).toBe(true);
    expect(
      assertInvalid(
        { ...response, affinity: affinityResponse.affinity },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid({ ...affinityResponse, affinity: undefined }, schema)
    ).toBe(true);
    expect(assertInvalid({ ...affinityResponse, affinity: null }, schema)).toBe(
      true
    );
    expect(assertInvalid({ ...response, unexpected: true }, schema)).toBe(true);
    expect(
      assertInvalid(
        {
          ...affinityResponse,
          affinity: {
            ...affinityResponse.affinity,
            projectRoot: "/private/project",
          },
        },
        schema
      )
    ).toBe(true);
    expect(JSON.stringify(affinityResponse.affinity)).not.toContain("/private");
  });

  test("rejects missing schemaVersion", () => {
    const response = {
      query: "alice",
      target: {},
      stages: [],
      chunk: {},
      meta: {},
    };

    expect(assertInvalid(response, schema)).toBe(true);
  });
});
