import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("ask schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("ask");
  });

  describe("valid inputs", () => {
    test("validates minimal ask response", () => {
      const response = {
        query: "how to deploy",
        mode: "hybrid",
        results: [],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates ask response with answer", () => {
      const response = {
        query: "what is the termination clause",
        mode: "hybrid",
        queryLanguage: "en",
        answer:
          "The termination clause allows either party to end the agreement with 30 days notice.",
        citations: [
          {
            docid: "#abc123",
            uri: "gno://work/contracts/nda.docx",
            startLine: 120,
            endLine: 125,
          },
        ],
        results: [
          {
            docid: "#abc123",
            score: 0.92,
            uri: "gno://work/contracts/nda.docx",
            snippet: "Either party may terminate this agreement...",
            source: {
              relPath: "contracts/nda.docx",
              mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              ext: ".docx",
            },
          },
        ],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
          answerGenerated: true,
          totalResults: 1,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates bm25_only mode", () => {
      const response = {
        query: "contract",
        mode: "bm25_only",
        results: [],
        meta: {
          expanded: false,
          reranked: false,
          vectorsUsed: false,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates response without answer (no generation)", () => {
      const response = {
        query: "deployment process",
        mode: "hybrid",
        results: [
          {
            docid: "#def456",
            score: 0.85,
            uri: "gno://work/runbooks/deploy.md",
            snippet: "To deploy to staging...",
            source: {
              relPath: "runbooks/deploy.md",
              mime: "text/markdown",
              ext: ".md",
            },
          },
        ],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
          answerGenerated: false,
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });

    test("validates optional answerContext explain payload", () => {
      const response = {
        query: "compare redis vs sqlite",
        mode: "hybrid",
        answer: "Redis is faster [1], SQLite is simpler [2].",
        citations: [
          { docid: "#abc123", uri: "gno://work/redis.md" },
          { docid: "#def456", uri: "gno://work/sqlite.md" },
        ],
        results: [],
        meta: {
          expanded: false,
          reranked: true,
          vectorsUsed: true,
          answerGenerated: true,
          totalResults: 2,
          answerContext: {
            strategy: "adaptive_coverage_v1",
            targetSources: 2,
            facets: ["redis", "sqlite"],
            selected: [
              {
                docid: "#abc123",
                uri: "gno://work/redis.md",
                score: 0.9,
                queryTokenHits: 2,
                facetHits: 1,
                reason: "comparison_balance",
              },
            ],
            dropped: [],
          },
        },
      };
      expect(assertValid(response, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing query", () => {
      const response = {
        mode: "hybrid",
        results: [],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects invalid mode", () => {
      const response = {
        query: "test",
        mode: "vector",
        results: [],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects missing meta", () => {
      const response = {
        query: "test",
        mode: "hybrid",
        results: [],
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects meta missing required fields", () => {
      const response = {
        query: "test",
        mode: "hybrid",
        results: [],
        meta: {
          expanded: true,
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });

    test("rejects invalid citation docid", () => {
      const response = {
        query: "test",
        mode: "hybrid",
        citations: [
          {
            docid: "invalid",
            uri: "gno://work/doc.md",
          },
        ],
        results: [],
        meta: {
          expanded: true,
          reranked: true,
          vectorsUsed: true,
        },
      };
      expect(assertInvalid(response, schema)).toBe(true);
    });
  });
});
