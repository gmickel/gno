import { describe, expect, mock, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type { StorePort } from "../../src/store/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { searchHybrid } from "../../src/pipeline/hybrid";

const NOW = "2026-04-07T00:00:00.000Z";

const config: Config = {
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [],
  contexts: [],
  models: {
    activePreset: "slim-tuned",
    presets: [
      {
        id: "slim-tuned",
        name: "Slim Tuned",
        embed:
          "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
        rerank: "hf:test/rerank.gguf",
        expand: "hf:test/expand.gguf",
        gen: "hf:test/gen.gguf",
      },
    ],
    loadTimeout: 60_000,
    inferenceTimeout: 30_000,
    expandContextSize: 2_048,
    warmModelTtl: 300_000,
  },
};

function createStore(): StorePort {
  return {
    searchFts: async () => ({ ok: true as const, value: [] }),
    getDocumentsByMirrorHashes: async () => ({
      ok: true as const,
      value: [
        {
          id: 1,
          collection: "notes",
          relPath: "doc.md",
          sourceHash: "hash-1",
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: 100,
          sourceMtime: NOW,
          sourceCtime: NOW,
          docid: "#hash1",
          uri: "gno://notes/doc.md",
          title: "Doc",
          mirrorHash: "hash-1",
          converterId: "md",
          converterVersion: "1.0.0",
          languageHint: "en",
          contentType: "note",
          categories: null,
          author: null,
          frontmatterDate: null,
          dateFields: null,
          active: true,
          indexedAt: NOW,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorAt: null,
          ingestVersion: 1,
        },
      ],
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
              text: "Latency budgets for search pages.",
              startLine: 1,
              endLine: 1,
              language: "en",
              tokenCount: null,
              createdAt: NOW,
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
  } as unknown as StorePort;
}

describe("hybrid vector query batching", () => {
  test("batch-embeds vector-style query variants when present", async () => {
    const embed = mock(async () => ({
      ok: true as const,
      value: [9, 9, 9],
    }));
    const embedBatch = mock(async (texts: string[]) => ({
      ok: true as const,
      value: texts.map((_, index) => [index + 0.1, index + 0.2, index + 0.3]),
    }));
    const embedPort = {
      modelUri:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      init: async () => ({ ok: true as const, value: undefined }),
      dimensions: () => 3,
      dispose: async () => undefined,
      embed,
      embedBatch,
    } as unknown as EmbeddingPort;

    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: embedPort.modelUri,
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
      searchNearest: async () => ({
        ok: true as const,
        value: [{ mirrorHash: "hash-1", seq: 0, distance: 0.1 }],
      }),
    };

    const result = await searchHybrid(
      {
        store: createStore(),
        config,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "performance",
      {
        queryModes: [
          { mode: "intent", text: "latency budgets" },
          { mode: "hyde", text: "Search pages focus on latency budgets." },
        ],
      }
    );

    expect(result.ok).toBe(true);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(0);
  });

  test("keeps single-query path on plain vector search", async () => {
    const embed = mock(async () => ({
      ok: true as const,
      value: [0.1, 0.2, 0.3],
    }));
    const embedBatch = mock(async () => ({
      ok: true as const,
      value: [[1, 2, 3]],
    }));
    const embedPort = {
      modelUri:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      init: async () => ({ ok: true as const, value: undefined }),
      dimensions: () => 3,
      dispose: async () => undefined,
      embed,
      embedBatch,
    } as unknown as EmbeddingPort;

    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: embedPort.modelUri,
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
      searchNearest: async () => ({
        ok: true as const,
        value: [{ mirrorHash: "hash-1", seq: 0, distance: 0.1 }],
      }),
    };

    const result = await searchHybrid(
      {
        store: createStore(),
        config,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "performance",
      {}
    );

    expect(result.ok).toBe(true);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embedBatch).toHaveBeenCalledTimes(0);
  });
});
