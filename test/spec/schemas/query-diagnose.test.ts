import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("query-diagnose schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("query-diagnose");
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

    expect(assertValid(response, schema)).toBe(true);
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
