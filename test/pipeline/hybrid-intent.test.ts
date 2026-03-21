import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";

import { searchHybrid } from "../../src/pipeline/hybrid";

const config: Config = {
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [],
  contexts: [],
  models: {
    activePreset: "slim",
    presets: [
      {
        id: "slim",
        name: "Slim",
        embed: "hf:test/embed.gguf",
        rerank: "hf:test/rerank.gguf",
        gen: "hf:test/gen.gguf",
      },
    ],
    loadTimeout: 60_000,
    inferenceTimeout: 30_000,
    expandContextSize: 2_048,
    warmModelTtl: 300_000,
  },
};

function createStore() {
  return {
    searchFts: async () => ({
      ok: true as const,
      value: [
        {
          mirrorHash: "hash-1",
          seq: 0,
          score: -15,
          docid: "#hash1",
          uri: "gno://notes/performance.md",
          title: "Performance",
          collection: "notes",
          relPath: "performance.md",
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceMtime: "2026-03-01T12:00:00.000Z",
          sourceSize: 100,
          sourceHash: "hash-1",
        },
        {
          mirrorHash: "hash-2",
          seq: 0,
          score: -2,
          docid: "#hash2",
          uri: "gno://notes/reviews.md",
          title: "Performance Reviews",
          collection: "notes",
          relPath: "reviews.md",
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceMtime: "2026-03-01T12:00:00.000Z",
          sourceSize: 100,
          sourceHash: "hash-2",
        },
      ],
    }),
    getDocumentsByMirrorHashes: async (hashes: string[]) => ({
      ok: true as const,
      value: hashes.map((hash, index) => ({
        id: index + 1,
        collection: "notes",
        relPath: hash === "hash-1" ? "performance.md" : "reviews.md",
        sourceHash: hash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 100,
        sourceMtime: "2026-03-01T12:00:00.000Z",
        sourceCtime: "2026-03-01T12:00:00.000Z",
        docid: hash === "hash-1" ? "#hash1" : "#hash2",
        uri:
          hash === "hash-1"
            ? "gno://notes/performance.md"
            : "gno://notes/reviews.md",
        title: hash === "hash-1" ? "Performance" : "Performance Reviews",
        mirrorHash: hash,
        converterId: "native/markdown",
        converterVersion: "1.0.0",
        languageHint: "en",
        contentType: "note",
        categories: null,
        author: null,
        frontmatterDate: null,
        dateFields: null,
        active: true,
        indexedAt: "2026-03-01T12:00:00.000Z",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        ingestVersion: 1,
      })),
    }),
    getCollections: async () => ({
      ok: true as const,
      value: [{ name: "notes", path: "/notes" }],
    }),
    getChunksBatch: async () => ({
      ok: true as const,
      value: new Map([
        [
          "hash-1",
          [
            {
              seq: 0,
              pos: 0,
              text: "Web performance budgets and latency tracking.",
              startLine: 1,
              endLine: 1,
              language: "en",
              tokenCount: null,
              createdAt: "2026-03-01T12:00:00.000Z",
            },
          ],
        ],
        [
          "hash-2",
          [
            {
              seq: 0,
              pos: 0,
              text: "Performance reviews and coaching loops.",
              startLine: 1,
              endLine: 1,
              language: "en",
              tokenCount: null,
              createdAt: "2026-03-01T12:00:00.000Z",
            },
          ],
        ],
      ]),
    }),
    getTagsBatch: async () => ({
      ok: true as const,
      value: new Map(),
    }),
    getContent: async () => ({ ok: true as const, value: null }),
  };
}

describe("hybrid intent steering", () => {
  test("intent disables strong-signal expansion bypass", async () => {
    let generateCalls = 0;
    const genPort = {
      modelUri: "hf:test/gen.gguf",
      generate: async () => {
        generateCalls += 1;
        return {
          ok: true as const,
          value: JSON.stringify({
            lexicalQueries: ["web performance"],
            vectorQueries: ["latency budgets"],
            hyde: "Performance focuses on web latency budgets.",
          }),
        };
      },
      dispose: async () => {
        // no-op
      },
    };

    const noIntent = await searchHybrid(
      {
        store: createStore() as never,
        config,
        vectorIndex: null,
        embedPort: null,
        expandPort: genPort as never,
        rerankPort: null,
      },
      "performance",
      {}
    );

    const withIntent = await searchHybrid(
      {
        store: createStore() as never,
        config,
        vectorIndex: null,
        embedPort: null,
        expandPort: genPort as never,
        rerankPort: null,
      },
      "performance",
      { intent: "web latency and vitals" }
    );

    expect(noIntent.ok).toBe(true);
    expect(withIntent.ok).toBe(true);
    if (!noIntent.ok || !withIntent.ok) {
      return;
    }

    expect(noIntent.value.meta.expanded).toBe(false);
    expect(withIntent.value.meta.expanded).toBe(true);
    expect(generateCalls).toBe(1);
  });

  test("exclude terms hard-prune matching candidates", async () => {
    const result = await searchHybrid(
      {
        store: createStore() as never,
        config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "performance",
      { exclude: ["reviews"] }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]?.uri).toBe("gno://notes/performance.md");
    expect(result.value.meta.exclude).toEqual(["reviews"]);
  });
});
