import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort, RerankPort } from "../../src/llm/types";
import type {
  ChunkRow,
  ContextRow,
  DocumentRow,
  FtsResult,
  StorePort,
} from "../../src/store/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";

const NOW = "2026-07-22T00:00:00.000Z";
const MIRROR_HASH = "context-document";
const EXPECTED_CONTEXT =
  "Global guidance\n\nNotes guidance\n\nProject guidance";

const document: DocumentRow = {
  id: 1,
  collection: "notes",
  relPath: "projects/alpha.md",
  sourceHash: "source-context-document",
  sourceMime: "text/markdown",
  sourceExt: ".md",
  sourceSize: 100,
  sourceMtime: NOW,
  docid: "#context",
  uri: "gno://notes/projects/alpha.md",
  title: "Context document",
  mirrorHash: MIRROR_HASH,
  converterId: "md",
  converterVersion: "1.0.0",
  languageHint: "en",
  active: true,
  ingestVersion: 1,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastErrorAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const ftsResult: FtsResult = {
  mirrorHash: MIRROR_HASH,
  seq: 0,
  score: -10,
  snippet: "Context snippet",
  docid: document.docid,
  uri: document.uri,
  title: document.title ?? undefined,
  collection: document.collection,
  relPath: document.relPath,
  sourceMime: document.sourceMime,
  sourceExt: document.sourceExt,
  sourceMtime: document.sourceMtime,
  sourceSize: document.sourceSize,
  sourceHash: document.sourceHash,
};

const chunk: ChunkRow = {
  mirrorHash: MIRROR_HASH,
  seq: 0,
  pos: 0,
  text: "Context chunk",
  startLine: 1,
  endLine: 1,
  language: "en",
  tokenCount: 3,
  createdAt: NOW,
};

const contexts: ContextRow[] = [
  {
    scopeType: "prefix",
    scopeKey: "gno://notes/projects",
    text: "Project guidance",
    syncedAt: NOW,
  },
  {
    scopeType: "global",
    scopeKey: "/",
    text: "Global guidance",
    syncedAt: NOW,
  },
  {
    scopeType: "collection",
    scopeKey: "notes:",
    text: "Notes guidance",
    syncedAt: NOW,
  },
];

function createStore(configuredContexts: ContextRow[]): {
  contextReads: () => number;
  store: StorePort;
} {
  let reads = 0;
  const store: Partial<StorePort> = {
    getContextGeneration: () => 0,
    getContexts: async () => {
      reads += 1;
      return { ok: true as const, value: configuredContexts };
    },
    searchFts: async () => ({ ok: true as const, value: [ftsResult] }),
    getCollections: async () => ({
      ok: true as const,
      value: [
        {
          name: "notes",
          path: "/tmp/notes",
          pattern: "**/*",
          include: null,
          exclude: null,
          updateCmd: null,
          languageHint: null,
          syncedAt: NOW,
        },
      ],
    }),
    getDocumentsByMirrorHashes: async () => ({
      ok: true as const,
      value: [document],
    }),
    getChunksBatch: async () => ({
      ok: true as const,
      value: new Map([[MIRROR_HASH, [chunk]]]),
    }),
    getContent: async () => ({
      ok: true as const,
      value: "Full context document",
    }),
  };
  return { contextReads: () => reads, store: store as StorePort };
}

const vectorIndex: VectorIndexPort = {
  searchAvailable: true,
  model: "test-model",
  dimensions: 3,
  vecDirty: false,
  upsertVectors: async () => ({ ok: true, value: undefined }),
  deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
  searchNearest: async () => ({
    ok: true as const,
    value: [{ mirrorHash: MIRROR_HASH, seq: 0, distance: 0.1 }],
  }),
  rebuildVecIndex: async () => ({ ok: true, value: undefined }),
  syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
};

const embedPort: EmbeddingPort = {
  modelUri: "test-model",
  init: async () => ({ ok: true, value: undefined }),
  embed: async () => ({ ok: true, value: [0.1, 0.2, 0.3] }),
  embedBatch: async () => ({ ok: true, value: [[0.1, 0.2, 0.3]] }),
  dimensions: () => 3,
  dispose: async () => {},
};

const rerankPort: RerankPort = {
  modelUri: "test-reranker",
  rerank: async () => ({
    ok: true,
    value: [{ index: 0, score: 1, rank: 1 }],
  }),
  dispose: async () => {},
};

async function runAllPipelines(configuredContexts: ContextRow[]): Promise<{
  contexts: Array<string | undefined>;
  ownContextFields: boolean[];
  reads: number[];
}> {
  const bm25Store = createStore(configuredContexts);
  const bm25 = await searchBm25(bm25Store.store, "context", {
    full: true,
    limit: 1,
  });

  const vectorStore = createStore(configuredContexts);
  const vector = await searchVectorWithEmbedding(
    {
      store: vectorStore.store,
      vectorIndex,
      embedPort,
      config: {} as Config,
    },
    "context",
    new Float32Array([0.1, 0.2, 0.3]),
    { full: true, limit: 1 }
  );

  const hybridStore = createStore(configuredContexts);
  const hybrid = await searchHybrid(
    {
      store: hybridStore.store,
      config: {} as Config,
      vectorIndex,
      embedPort,
      expandPort: null,
      rerankPort,
    },
    "context",
    { full: true, limit: 1, noExpand: true }
  );

  expect(bm25.ok).toBe(true);
  expect(vector.ok).toBe(true);
  expect(hybrid.ok).toBe(true);
  if (!(bm25.ok && vector.ok && hybrid.ok)) {
    throw new Error("Expected every retrieval pipeline to succeed");
  }

  const results = [
    bm25.value.results[0],
    vector.value.results[0],
    hybrid.value.results[0],
  ];
  expect(results.every(Boolean)).toBe(true);

  return {
    contexts: results.map((result) => result?.context),
    ownContextFields: results.map((result) =>
      Object.hasOwn(result ?? {}, "context")
    ),
    reads: [
      bm25Store.contextReads(),
      vectorStore.contextReads(),
      hybridStore.contextReads(),
    ],
  };
}

describe("retrieval context propagation", () => {
  test("returns identical context after BM25, vector, full-content, fusion, and rerank paths", async () => {
    const result = await runAllPipelines(contexts);

    expect(result.contexts).toEqual([
      EXPECTED_CONTEXT,
      EXPECTED_CONTEXT,
      EXPECTED_CONTEXT,
    ]);
    expect(result.reads).toEqual([1, 1, 1]);
  });

  test("keeps the historical optional-field shape without configured context", async () => {
    const result = await runAllPipelines([]);

    expect(result.contexts).toEqual([undefined, undefined, undefined]);
    expect(result.ownContextFields).toEqual([false, false, false]);
    expect(result.reads).toEqual([1, 1, 1]);
  });
});
