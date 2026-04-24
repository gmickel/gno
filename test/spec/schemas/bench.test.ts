import Ajv from "ajv";
// oxlint-disable-next-line import/no-namespace -- ajv-formats exposes default in CJS-compatible namespace
import * as addFormatsModule from "ajv-formats";
import { describe, expect, test } from "bun:test";

import benchFixtureSchema from "../../../spec/bench-fixture.schema.json";
import benchResultSchema from "../../../spec/output-schemas/bench-result.schema.json";

const addFormats = addFormatsModule.default;

const ajv = new Ajv();
addFormats(ajv);
const validateFixture = ajv.compile(benchFixtureSchema);
const validateResult = ajv.compile(benchResultSchema);

describe("bench schemas", () => {
  test("valid fixture", () => {
    const fixture = {
      version: 1,
      metadata: {
        name: "Docs smoke",
        description: "Stable BM25 fixture",
        tags: ["smoke"],
      },
      collection: "docs",
      topK: 3,
      modes: [
        "bm25",
        {
          name: "fast-hybrid",
          mode: "fast",
          candidateLimit: 8,
          queryModes: [{ mode: "term", text: "jwt token" }],
        },
      ],
      queries: [
        {
          id: "jwt",
          query: "JWT token",
          expected: ["authentication.md"],
          judgments: [{ doc: "authentication.md", relevance: 2 }],
        },
      ],
    };

    expect(validateFixture(fixture)).toBe(true);
  });

  test("valid result", () => {
    const result = {
      fixture: {
        path: "/tmp/fixture.json",
        name: "Docs smoke",
        version: 1,
        queryCount: 1,
        topK: 3,
      },
      generatedAt: new Date().toISOString(),
      modes: [
        {
          name: "bm25",
          type: "bm25",
          status: "ok",
          queryCount: 1,
          failures: 0,
          metrics: {
            precisionAtK: 0.3333,
            recallAtK: 1,
            f1AtK: 0.5,
            mrr: 1,
            ndcgAtK: 1,
          },
          latency: {
            p50Ms: 4.2,
            p95Ms: 4.2,
            meanMs: 4.2,
          },
          cases: [
            {
              id: "jwt",
              query: "JWT token",
              topK: 3,
              expected: ["authentication.md"],
              hits: ["authentication.md"],
              topDocs: ["authentication.md"],
              metrics: {
                precisionAtK: 0.3333,
                recallAtK: 1,
                f1AtK: 0.5,
                mrr: 1,
                ndcgAtK: 1,
              },
              latencyMs: 4.2,
            },
          ],
        },
      ],
      meta: {
        indexName: "default",
        collection: "docs",
      },
    };

    expect(validateResult(result)).toBe(true);
  });
});
