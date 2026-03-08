import { describe, expect, test } from "bun:test";

import { expandQuery } from "../../src/pipeline/expansion";
import {
  buildIntentAwareRerankQuery,
  extractSteeringTerms,
  selectBestChunkForSteering,
} from "../../src/pipeline/intent";

describe("intent helpers", () => {
  test("extractSteeringTerms keeps short domain terms and strips stopwords", () => {
    expect(
      extractSteeringTerms("API, SQL, and LLM latency for the web")
    ).toEqual(["api", "sql", "llm", "latency", "web"]);
  });

  test("selectBestChunkForSteering favors intent-relevant chunk when query terms tie", () => {
    const chunks = [
      {
        mirrorHash: "hash-a",
        seq: 0,
        pos: 0,
        text: "Performance budgets for web latency and Core Web Vitals.",
        startLine: 1,
        endLine: 1,
        language: "en",
        tokenCount: null,
        createdAt: "2026-03-01T12:00:00.000Z",
      },
      {
        mirrorHash: "hash-a",
        seq: 1,
        pos: 1,
        text: "Performance reviews, coaching, and team growth.",
        startLine: 2,
        endLine: 2,
        language: "en",
        tokenCount: null,
        createdAt: "2026-03-01T12:00:00.000Z",
      },
    ];

    const best = selectBestChunkForSteering(
      chunks,
      "performance",
      "web latency",
      {
        preferredSeq: 1,
        intentWeight: 0.5,
      }
    );

    expect(best?.seq).toBe(0);
  });

  test("buildIntentAwareRerankQuery prepends intent without replacing query", () => {
    expect(
      buildIntentAwareRerankQuery("performance", "web latency and vitals")
    ).toBe("Intent: web latency and vitals\nQuery: performance");
    expect(buildIntentAwareRerankQuery("performance")).toBe("performance");
  });
});

describe("expandQuery intent support", () => {
  test("passes intent and bounded context size into generation prompt", async () => {
    let capturedPrompt = "";
    let capturedContextSize: number | undefined;

    const genPort = {
      modelUri: "hf:test/gen.gguf",
      generate: async (prompt: string, params?: { contextSize?: number }) => {
        capturedPrompt = prompt;
        capturedContextSize = params?.contextSize;
        return {
          ok: true as const,
          value: JSON.stringify({
            lexicalQueries: ["web performance"],
            vectorQueries: ["latency optimization"],
            hyde: "Web performance depends on latency and rendering budgets.",
          }),
        };
      },
      dispose: async () => {
        // no-op
      },
    };

    const result = await expandQuery(genPort, "performance", {
      intent: "web latency and Core Web Vitals",
      contextSize: 2048,
    });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain('Query: "performance"');
    expect(capturedPrompt).toContain(
      'Query intent: "web latency and Core Web Vitals"'
    );
    expect(capturedContextSize).toBe(2048);
  });
});
