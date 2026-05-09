/**
 * Regression tests for hybrid search document lookup path.
 * Ensures targeted doc fetch is used instead of full scans.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { RerankPort } from "../../src/llm/types";
import type {
  ChunkRow,
  CollectionRow,
  DocumentRow,
  FtsResult,
  GraphResult,
  StorePort,
} from "../../src/store/types";

import { searchHybrid } from "../../src/pipeline/hybrid";

const NOW = "2026-02-22T00:00:00.000Z";

const makeDoc = (
  id: number,
  mirrorHash: string,
  metadata?: { sourceMtime?: string; frontmatterDate?: string | null }
): DocumentRow => ({
  id,
  collection: "notes",
  relPath: `${mirrorHash}.md`,
  sourceHash: `source_${mirrorHash}`,
  sourceMime: "text/markdown",
  sourceExt: ".md",
  sourceSize: 100,
  sourceMtime: metadata?.sourceMtime ?? NOW,
  docid: `#${mirrorHash}`,
  uri: `gno://notes/${mirrorHash}.md`,
  title: `Doc ${mirrorHash}`,
  mirrorHash,
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
  frontmatterDate: metadata?.frontmatterDate ?? null,
});

const makeChunk = (mirrorHash: string, seq: number): ChunkRow => ({
  mirrorHash,
  seq,
  pos: seq * 100,
  text: `Chunk ${mirrorHash}:${seq}`,
  startLine: seq + 1,
  endLine: seq + 1,
  language: "en",
  tokenCount: 20,
  createdAt: NOW,
});

const makeFtsResult = (mirrorHash: string, seq: number): FtsResult => ({
  mirrorHash,
  seq,
  score: -1.0,
});

const makeGraph = (
  links: GraphResult["links"],
  nodes: GraphResult["nodes"]
): GraphResult => ({
  nodes,
  links,
  report: {
    hubs: [],
    bridgeCandidates: [],
    isolated: { total: 0, examples: [] },
    unresolvedLinks: { total: 0, byType: { wiki: 0, markdown: 0 } },
    edgeTypes: { wiki: 0, markdown: 0, similar: 0 },
    edgeConfidence: { explicit: 0, inferred: 0, ambiguous: 0, similarity: 0 },
    audit: { inferredEdges: 0, ambiguousEdges: 0, similarityEdges: 0 },
  },
  meta: {
    collection: "notes",
    nodeLimit: 2000,
    edgeLimit: 10000,
    totalNodes: nodes.length,
    totalEdges: links.length,
    totalEdgesUnresolved: 0,
    returnedNodes: nodes.length,
    returnedEdges: links.length,
    truncated: false,
    linkedOnly: true,
    includedSimilar: false,
    similarAvailable: false,
    similarTopK: 5,
    similarTruncatedByComputeBudget: false,
    warnings: [],
  },
});

const graphNode = (mirrorHash: string): GraphResult["nodes"][number] => ({
  id: `#${mirrorHash}`,
  uri: `gno://notes/${mirrorHash}.md`,
  title: `Doc ${mirrorHash}`,
  collection: "notes",
  relPath: `${mirrorHash}.md`,
  degree: 1,
});

const createGraphStore = (
  links: GraphResult["links"],
  options: {
    docs?: string[];
    fts?: string[];
    onGetDocumentByDocid?: (docid: string) => void;
  } = {}
): Partial<StorePort> => {
  const hashes = options.docs ?? ["seed", "explicit", "inferred", "ambiguous"];
  const docs = new Map(
    hashes.map((hash, index) => [`#${hash}`, makeDoc(index + 1, hash)])
  );
  return {
    searchFts: async () => ({
      ok: true as const,
      value: (options.fts ?? ["seed"]).map((hash) => makeFtsResult(hash, 0)),
    }),
    getGraph: async () => ({
      ok: true as const,
      value: makeGraph(links, hashes.map(graphNode)),
    }),
    getDocumentByDocid: async (docid) => {
      options.onGetDocumentByDocid?.(docid);
      return { ok: true as const, value: docs.get(docid) ?? null };
    },
    getDocumentsByMirrorHashes: async (requestedHashes) => ({
      ok: true as const,
      value: requestedHashes
        .map((hash) => docs.get(`#${hash}`))
        .filter((doc): doc is DocumentRow => Boolean(doc)),
    }),
    getCollections: async () => ({
      ok: true as const,
      value: TEST_COLLECTIONS,
    }),
    getChunksBatch: async (requestedHashes) => {
      const map = new Map<string, ChunkRow[]>();
      for (const hash of requestedHashes) {
        map.set(hash, [makeChunk(hash, 0)]);
      }
      return { ok: true as const, value: map };
    },
  };
};

const TEST_COLLECTIONS: CollectionRow[] = [
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
];

describe("searchHybrid targeted document lookup", () => {
  test("uses getDocumentsByMirrorHashes, never listDocuments", async () => {
    const captured: { hashes: string[]; activeOnly?: boolean } = { hashes: [] };

    const store: Partial<StorePort> = {
      listDocuments: () => {
        throw new Error("N+1 detected: listDocuments should not be called");
      },
      searchFts: async () => ({
        ok: true as const,
        value: [makeFtsResult("hash_a", 0)],
      }),
      getDocumentsByMirrorHashes: async (hashes, options) => {
        captured.hashes = hashes;
        captured.activeOnly = options?.activeOnly;
        return {
          ok: true as const,
          value: [makeDoc(1, "hash_a")],
        };
      },
      getCollections: async () => ({
        ok: true as const,
        value: TEST_COLLECTIONS,
      }),
      getChunksBatch: async (hashes) => {
        const map = new Map<string, ChunkRow[]>();
        for (const hash of hashes) {
          map.set(hash, [makeChunk(hash, 0)]);
        }
        return { ok: true as const, value: map };
      },
    };

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "hybrid query",
      {
        noExpand: true,
        explain: true,
        limit: 5,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(captured.hashes).toEqual(["hash_a"]);
    expect(captured.activeOnly).toBe(true);
    expect(result.value.results).toHaveLength(1);
    expect(result.value.meta.mode).toBe("bm25_only");
    expect(result.value.meta.vectorsUsed).toBe(false);

    const timingLine = result.value.meta.explain?.lines.find(
      (line) => line.stage === "timing"
    );
    expect(timingLine).toBeTruthy();
    expect(timingLine?.message).toContain("total=");

    const countersLine = result.value.meta.explain?.lines.find(
      (line) => line.stage === "counters"
    );
    expect(countersLine).toBeTruthy();
    expect(countersLine?.message).toContain("fallbacks=");
  });

  test("sorts newest-first for recency intent using doc date fallback", async () => {
    const store: Partial<StorePort> = {
      listDocuments: () => {
        throw new Error("N+1 detected: listDocuments should not be called");
      },
      searchFts: async () => ({
        ok: true as const,
        value: [makeFtsResult("hash_a", 0), makeFtsResult("hash_b", 0)],
      }),
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [
          makeDoc(1, "hash_a", {
            sourceMtime: "2025-01-01T00:00:00.000Z",
            frontmatterDate: "2025-01-01T00:00:00.000Z",
          }),
          makeDoc(2, "hash_b", {
            sourceMtime: "2025-01-20T00:00:00.000Z",
            frontmatterDate: null,
          }),
        ],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: TEST_COLLECTIONS,
      }),
      getChunksBatch: async (hashes) => {
        const map = new Map<string, ChunkRow[]>();
        for (const hash of hashes) {
          map.set(hash, [makeChunk(hash, 0)]);
        }
        return { ok: true as const, value: map };
      },
    };

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "latest notes",
      {
        noExpand: true,
        noRerank: true,
        limit: 2,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results).toHaveLength(2);
    expect(result.value.results[0]?.source.relPath).toBe("hash_b.md");
    expect(result.value.results[1]?.source.relPath).toBe("hash_a.md");
  });

  test("expands one-hop graph neighbors when embeddings are unavailable", async () => {
    const store = createGraphStore([
      {
        source: "#seed",
        target: "#explicit",
        type: "wiki",
        weight: 1,
        confidence: "explicit",
        audit: { resolution: "exact-title", matchCount: 1 },
      },
    ]);

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "seed query",
      { noExpand: true, noRerank: true, limit: 2, explain: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results.map((r) => r.source.relPath)).toContain(
      "explicit.md"
    );
    expect(result.value.meta.mode).toBe("bm25_only");
    expect(result.value.meta.graphExpansion?.enabled).toBe(true);
    expect(result.value.meta.graphExpansion?.candidateCount).toBe(1);
    expect(
      result.value.meta.explain?.lines.some((l) => l.stage === "graph")
    ).toBe(true);
  });

  test("graph expansion fallback preserves current retrieval output", async () => {
    const baseStore: Partial<StorePort> = {
      searchFts: async () => ({
        ok: true as const,
        value: [makeFtsResult("seed", 0)],
      }),
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [makeDoc(1, "seed")],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: TEST_COLLECTIONS,
      }),
      getChunksBatch: async () => ({
        ok: true as const,
        value: new Map([["seed", [makeChunk("seed", 0)]]]),
      }),
    };
    const graphStore: Partial<StorePort> = {
      ...baseStore,
      getGraph: async () => ({
        ok: true as const,
        value: makeGraph([], [graphNode("seed")]),
      }),
    };

    const deps = {
      config: {} as Config,
      vectorIndex: null,
      embedPort: null,
      expandPort: null,
      rerankPort: null,
    };
    const withoutGraph = await searchHybrid(
      { ...deps, store: baseStore as StorePort },
      "seed query",
      { noExpand: true, noRerank: true, limit: 2 }
    );
    const emptyGraph = await searchHybrid(
      { ...deps, store: graphStore as StorePort },
      "seed query",
      { noExpand: true, noRerank: true, limit: 2 }
    );

    expect(withoutGraph.ok).toBe(true);
    expect(emptyGraph.ok).toBe(true);
    if (!withoutGraph.ok || !emptyGraph.ok) {
      return;
    }
    expect(emptyGraph.value.results).toEqual(withoutGraph.value.results);
    expect(emptyGraph.value.meta.graphExpansion?.enabled).toBe(false);
  });

  test("graph expansion enforces candidate cap", async () => {
    const requestedDocids: string[] = [];
    const store = createGraphStore(
      ["one", "two", "three", "four"].map((hash) => ({
        source: "#seed",
        target: `#${hash}`,
        type: "wiki" as const,
        weight: 1,
        confidence: "explicit" as const,
        audit: { resolution: "exact-title" as const, matchCount: 1 },
      })),
      {
        docs: ["seed", "one", "two", "three", "four"],
        onGetDocumentByDocid: (docid) => requestedDocids.push(docid),
      }
    );

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "seed query",
      { noExpand: true, noRerank: true, candidateLimit: 2, limit: 5 }
    );

    expect(result.ok).toBe(true);
    expect(requestedDocids).toHaveLength(2);
    if (result.ok) {
      expect(result.value.meta.graphExpansion?.candidateCount).toBe(2);
      expect(result.value.meta.graphExpansion?.maxCandidates).toBe(2);
    }
  });

  test("explicit graph neighbors outrank inferred and ambiguous neighbors", async () => {
    const store = createGraphStore([
      {
        source: "#seed",
        target: "#inferred",
        type: "wiki",
        weight: 1,
        confidence: "inferred",
        audit: { resolution: "path-fallback", matchCount: 1 },
      },
      {
        source: "#seed",
        target: "#ambiguous",
        type: "wiki",
        weight: 1,
        confidence: "ambiguous",
        audit: { resolution: "ambiguous-fallback", matchCount: 2 },
      },
      {
        source: "#seed",
        target: "#explicit",
        type: "markdown",
        weight: 1,
        confidence: "explicit",
        audit: { resolution: "exact-path", matchCount: 1 },
      },
    ]);

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "seed query",
      { noExpand: true, noRerank: true, limit: 4 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const paths = result.value.results.map((r) => r.source.relPath);
    expect(paths.indexOf("explicit.md")).toBeLessThan(
      paths.indexOf("inferred.md")
    );
    expect(paths.indexOf("explicit.md")).toBeLessThan(
      paths.indexOf("ambiguous.md")
    );
  });

  test("graph candidates participate in reranking", async () => {
    const store = createGraphStore([
      {
        source: "#seed",
        target: "#explicit",
        type: "wiki",
        weight: 1,
        confidence: "explicit",
        audit: { resolution: "exact-title", matchCount: 1 },
      },
    ]);
    const rerankedDocs: string[] = [];
    const rerankPort: RerankPort = {
      modelUri: "test:rerank",
      rerank: async (_query, documents) => ({
        ok: true as const,
        value: documents.map((doc, index) => {
          rerankedDocs.push(doc);
          return {
            index,
            score: doc.includes("explicit") ? 10 : 1,
            rank: doc.includes("explicit") ? 1 : 2,
          };
        }),
      }),
      dispose: async () => {},
    };

    const result = await searchHybrid(
      {
        store: store as StorePort,
        config: {} as Config,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort,
      },
      "seed query",
      { noExpand: true, limit: 2 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(rerankedDocs.some((doc) => doc.includes("explicit"))).toBe(true);
    expect(result.value.results.map((r) => r.source.relPath)).toContain(
      "explicit.md"
    );
    expect(result.value.meta.reranked).toBe(true);
  });
});
