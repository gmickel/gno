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
import { SEARCH_RESULT_PLANNER_METADATA } from "../../src/pipeline/types";

const NOW = "2026-02-22T00:00:00.000Z";

const makeDoc = (
  id: number,
  mirrorHash: string,
  metadata?: {
    sourceMtime?: string;
    frontmatterDate?: string | null;
    categories?: string[];
    author?: string;
  }
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
  categories: metadata?.categories ?? null,
  author: metadata?.author ?? null,
});

const makeChunk = (
  mirrorHash: string,
  seq: number,
  language = "en"
): ChunkRow => ({
  mirrorHash,
  seq,
  pos: seq * 100,
  text: `Chunk ${mirrorHash}:${seq}`,
  startLine: seq + 1,
  endLine: seq + 1,
  language,
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
    communities: {
      total: 0,
      algorithm: "deterministic-label-propagation",
      skipped: false,
      assignments: {},
      top: [],
    },
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
    docMetadata?: Record<
      string,
      Parameters<typeof makeDoc>[2] & { tags?: string[]; language?: string }
    >;
    chunkSeqs?: Record<string, number[]>;
    onGetDocumentsByDocids?: (docids: string[]) => void;
  } = {}
): Partial<StorePort> => {
  const hashes = options.docs ?? ["seed", "explicit", "inferred", "ambiguous"];
  const docs = new Map(
    hashes.map((hash, index) => [
      `#${hash}`,
      makeDoc(index + 1, hash, options.docMetadata?.[hash]),
    ])
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
      return { ok: true as const, value: docs.get(docid) ?? null };
    },
    getDocumentsByDocids: async (docids) => {
      options.onGetDocumentsByDocids?.(docids);
      return {
        ok: true as const,
        value: docids
          .map((docid) => docs.get(docid))
          .filter((doc): doc is DocumentRow => Boolean(doc)),
      };
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
        const seqs = options.chunkSeqs?.[hash] ?? [0];
        const language = options.docMetadata?.[hash]?.language ?? "en";
        map.set(
          hash,
          seqs.map((seq) => makeChunk(hash, seq, language))
        );
      }
      return { ok: true as const, value: map };
    },
    getTagsBatch: async (documentIds) => {
      const values = new Map();
      for (const doc of docs.values()) {
        if (!documentIds.includes(doc.id)) {
          continue;
        }
        const tags = options.docMetadata?.[doc.mirrorHash ?? ""]?.tags ?? [];
        values.set(
          doc.id,
          tags.map((tag) => ({ tag, source: "frontmatter" as const }))
        );
      }
      return { ok: true as const, value: values };
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
  test("preserves same-mirror documents in canonical URI order with planner metadata", async () => {
    const sharedHash = "shared";
    const notesDoc = makeDoc(1, sharedHash);
    const archiveDoc: DocumentRow = {
      ...makeDoc(2, sharedHash),
      collection: "archive",
      relPath: "shared-copy.md",
      docid: "#archive",
      uri: "gno://archive/shared-copy.md",
      sourceHash: "archive-source",
    };
    const store: Partial<StorePort> = {
      searchFts: async () => ({
        ok: true as const,
        value: [makeFtsResult(sharedHash, 0)],
      }),
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [notesDoc, archiveDoc],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: [
          ...TEST_COLLECTIONS,
          {
            name: "archive",
            path: "/tmp/archive",
            pattern: "**/*",
            include: null,
            exclude: null,
            updateCmd: null,
            languageHint: null,
            syncedAt: NOW,
          },
        ],
      }),
      getChunksBatch: async () => ({
        ok: true as const,
        value: new Map([[sharedHash, [makeChunk(sharedHash, 0)]]]),
      }),
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
      "shared",
      { noExpand: true, noRerank: true, limit: 5 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((item) => item.uri)).toEqual([
      "gno://archive/shared-copy.md",
      "gno://notes/shared.md",
    ]);
    expect(
      result.value.results.map(
        (item) => item[SEARCH_RESULT_PLANNER_METADATA]?.retrievalRank
      )
    ).toEqual([1, 1]);
    expect(JSON.stringify(result.value.results)).not.toContain("retrievalRank");
  });

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

  test("skips graph expansion by default", async () => {
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

    expect(result.value.results.map((r) => r.source.relPath)).not.toContain(
      "explicit.md"
    );
    expect(result.value.meta.graphExpansion?.enabled).toBe(false);
    expect(result.value.meta.graphExpansion?.fallbackReasons).toContain(
      "graph_disabled"
    );
  });

  test("expands one-hop graph neighbors when explicitly enabled and embeddings are unavailable", async () => {
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
      { graph: true, noExpand: true, noRerank: true, limit: 2, explain: true }
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
      { graph: true, noExpand: true, noRerank: true, limit: 2 }
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
        onGetDocumentsByDocids: (docids) => requestedDocids.push(...docids),
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
      {
        graph: true,
        noExpand: true,
        noRerank: true,
        candidateLimit: 2,
        limit: 5,
      }
    );

    expect(result.ok).toBe(true);
    expect(requestedDocids).toHaveLength(4);
    if (result.ok) {
      expect(result.value.meta.graphExpansion?.candidateCount).toBe(2);
      expect(result.value.meta.graphExpansion?.maxCandidates).toBe(2);
    }
  });

  test("graph expansion caps candidates after active filters", async () => {
    const store = createGraphStore(
      [
        {
          source: "#seed",
          target: "#dropone",
          type: "wiki",
          weight: 4,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
        {
          source: "#seed",
          target: "#droptwo",
          type: "wiki",
          weight: 3,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
        {
          source: "#seed",
          target: "#valid",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
      ],
      {
        docs: ["seed", "dropone", "droptwo", "valid"],
        docMetadata: {
          seed: { tags: ["keep"], sourceMtime: NOW, language: "en" },
          dropone: { tags: ["drop"], sourceMtime: NOW, language: "en" },
          droptwo: { tags: ["drop"], sourceMtime: NOW, language: "en" },
          valid: { tags: ["keep"], sourceMtime: NOW, language: "en" },
        },
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
      {
        noExpand: true,
        noRerank: true,
        graph: true,
        candidateLimit: 1,
        limit: 5,
        tagsAll: ["keep"],
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results.map((r) => r.source.relPath)).toContain(
      "valid.md"
    );
    expect(result.value.meta.graphExpansion?.candidateCount).toBe(1);
    expect(result.value.meta.graphExpansion?.maxCandidates).toBe(1);
  });

  test("graph expansion keeps candidates within active filters", async () => {
    const store = createGraphStore(
      [
        {
          source: "#seed",
          target: "#valid",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
        {
          source: "#seed",
          target: "#wrongtag",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
        {
          source: "#seed",
          target: "#old",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
        {
          source: "#seed",
          target: "#fr",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
      ],
      {
        docs: ["seed", "valid", "wrongtag", "old", "fr"],
        docMetadata: {
          seed: { tags: ["keep"], sourceMtime: NOW, language: "en" },
          valid: { tags: ["keep"], sourceMtime: NOW, language: "en" },
          wrongtag: { tags: ["drop"], sourceMtime: NOW, language: "en" },
          old: {
            tags: ["keep"],
            sourceMtime: "2025-01-01T00:00:00.000Z",
            language: "en",
          },
          fr: { tags: ["keep"], sourceMtime: NOW, language: "fr" },
        },
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
      {
        noExpand: true,
        noRerank: true,
        graph: true,
        limit: 5,
        tagsAll: ["keep"],
        since: "2026-01-01",
        lang: "en",
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results.map((r) => r.source.relPath)).toContain(
      "valid.md"
    );
    expect(result.value.results.map((r) => r.source.relPath)).not.toContain(
      "wrongtag.md"
    );
    expect(result.value.results.map((r) => r.source.relPath)).not.toContain(
      "old.md"
    );
    expect(result.value.results.map((r) => r.source.relPath)).not.toContain(
      "fr.md"
    );
    expect(result.value.meta.graphExpansion?.candidateCount).toBe(1);
  });

  test("graph expansion reuses existing candidate seq for document-level boosts", async () => {
    const store = createGraphStore(
      [
        {
          source: "#seed",
          target: "#related",
          type: "wiki",
          weight: 1,
          confidence: "explicit",
          audit: { resolution: "exact-title", matchCount: 1 },
        },
      ],
      {
        docs: ["seed", "related"],
        fts: ["seed", "related"],
        chunkSeqs: { seed: [0], related: [2] },
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
      { graph: true, noExpand: true, noRerank: true, limit: 5, explain: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const related = result.value.results.find(
      (entry) => entry.source.relPath === "related.md"
    );
    expect(related?.snippet).toBe("Chunk related:2");
    const timingLine = result.value.meta.explain?.lines.find(
      (line) => line.stage === "timing"
    );
    expect(timingLine?.message).toContain("graph=");
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
      { graph: true, noExpand: true, noRerank: true, limit: 4 }
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
      { graph: true, noExpand: true, limit: 2 }
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
