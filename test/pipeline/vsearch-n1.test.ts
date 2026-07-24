/**
 * N+1 regression tests for vector search pipeline.
 * Ensures we use targeted document lookups and avoid full document scans.
 */

import { describe, expect, test } from "bun:test";

import type { NormalizedContentTypeRule } from "../../src/config/content-types";
import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type {
  ChunkRow,
  CollectionRow,
  DocumentRow,
  StorePort,
} from "../../src/store/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { getProjectAffinityMetadata } from "../../src/pipeline/project-affinity";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";

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

describe("searchVectorWithEmbedding N+1 guard", () => {
  test("content-type boosts neither oversample nor rescue below-minScore neighbors", async () => {
    let capturedLimit: number | undefined;
    let capturedMinScore: number | undefined;
    const boostedDoc: DocumentRow = {
      ...makeDoc(1, "boosted"),
      contentType: "decision",
    };
    const store: Partial<StorePort> = {
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [boostedDoc],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: TEST_COLLECTIONS,
      }),
      getChunksBatch: async () => ({
        ok: true as const,
        value: new Map([["boosted", [makeChunk("boosted", 0)]]]),
      }),
    };
    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async (_embedding, limit, options) => {
        capturedLimit = limit;
        capturedMinScore = options?.minScore;
        return {
          ok: true as const,
          value: [{ mirrorHash: "boosted", seq: 0, distance: 1.5 }],
        };
      },
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };
    const contentTypeRules: NormalizedContentTypeRule[] = [
      {
        id: "decision",
        preset: "decision-note",
        prefixes: [],
        searchBoost: 2,
      },
    ];

    const result = await searchVectorWithEmbedding(
      {
        store: store as StorePort,
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: {} as Config,
      },
      "query",
      new Float32Array([0.1, 0.2, 0.3]),
      {
        contentTypeRules,
        limit: 1,
        minScore: 0.3,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(capturedLimit).toBe(1);
    expect(capturedMinScore).toBe(0.3);
    expect(result.value.results).toEqual([]);
  });

  test("oversamples a bounded pool before affinity reorders output", async () => {
    let requestedLimit: number | undefined;
    const hashes = ["best", "second", "project", "fourth", "fifth", "sixth"];
    const documents = hashes.map((hash, index) => ({
      ...makeDoc(index + 1, hash),
      collection: hash === "project" ? "notes" : "archive",
      uri: `gno://${hash === "project" ? "notes" : "archive"}/${hash}.md`,
    }));
    const store: Partial<StorePort> = {
      getDocumentsByMirrorHashes: async (requestedHashes) => ({
        ok: true as const,
        value: documents.filter((doc) =>
          requestedHashes.includes(doc.mirrorHash!)
        ),
      }),
      getCollections: async () => ({
        ok: true as const,
        value: [
          ...TEST_COLLECTIONS,
          { ...TEST_COLLECTIONS[0]!, name: "archive", path: "/tmp/archive" },
        ],
      }),
      getChunksBatch: async (requestedHashes) => ({
        ok: true as const,
        value: new Map(
          requestedHashes.map((hash) => [hash, [makeChunk(hash, 0)]])
        ),
      }),
    };
    const neighbors = [
      { mirrorHash: "best", seq: 0, distance: 0 },
      { mirrorHash: "second", seq: 0, distance: 1 },
      { mirrorHash: "project", seq: 0, distance: 1.02 },
      { mirrorHash: "fourth", seq: 0, distance: 1.2 },
      { mirrorHash: "fifth", seq: 0, distance: 1.4 },
      { mirrorHash: "sixth", seq: 0, distance: 1.6 },
    ];
    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async (_embedding, limit) => {
        requestedLimit = limit;
        return {
          ok: true as const,
          value: neighbors.slice(0, limit),
        };
      },
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };

    const result = await searchVectorWithEmbedding(
      {
        store: store as StorePort,
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: {} as Config,
      },
      "query",
      new Float32Array([0.1, 0.2, 0.3]),
      {
        limit: 2,
        projectAffinity: {
          resolution: {
            matches: [
              {
                collection: "notes",
                collectionAlias: "collection_000000000000",
                distance: 0,
                relation: "exact",
                rootAlias: "root_000000000000",
                source: "cli_cwd",
              },
            ],
            roots: [],
          },
        },
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedLimit).toBe(6);
    expect(result.value.results.map((entry) => entry.docid)).toEqual([
      "#best",
      "#project",
    ]);
  });

  test("scores same-mirror collection copies independently", async () => {
    let capturedMinScore: number | undefined = Number.NaN;
    const projectDoc = makeDoc(1, "shared");
    const archiveDoc: DocumentRow = {
      ...makeDoc(2, "shared"),
      collection: "archive",
      docid: "#archive0",
      uri: "gno://archive/shared.md",
      relPath: "shared.md",
    };
    const store: Partial<StorePort> = {
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [projectDoc, archiveDoc],
      }),
      getCollections: async () => ({
        ok: true as const,
        value: [
          ...TEST_COLLECTIONS,
          { ...TEST_COLLECTIONS[0]!, name: "archive", path: "/tmp/archive" },
        ],
      }),
      getChunksBatch: async () => ({
        ok: true as const,
        value: new Map([["shared", [makeChunk("shared", 0)]]]),
      }),
    };
    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async (_embedding, _limit, options) => {
        capturedMinScore = options?.minScore;
        return {
          ok: true as const,
          value: [{ mirrorHash: "shared", seq: 0, distance: 1.5 }],
        };
      },
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };

    const result = await searchVectorWithEmbedding(
      {
        store: store as StorePort,
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: {} as Config,
      },
      "query",
      new Float32Array([0.1, 0.2, 0.3]),
      {
        minScore: 0.27,
        projectAffinity: {
          resolution: {
            matches: [
              {
                collection: "notes",
                collectionAlias: "collection_000000000000",
                distance: 0,
                relation: "exact",
                rootAlias: "root_000000000000",
                source: "cli_cwd",
              },
            ],
            roots: [],
          },
        },
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(capturedMinScore).toBeUndefined();
    expect(result.value.results.map((entry) => entry.docid)).toEqual([
      "#shared",
    ]);
    expect(result.value.results[0]?.score).toBeCloseTo(0.28);
    const affinity = getProjectAffinityMetadata(result.value.results[0]!);
    expect(affinity).toMatchObject({
      baseScore: 0.25,
      rawScore: 1.5,
      rawScoreKind: "vector_distance",
    });
    expect(affinity?.affinityApplied).toBeCloseTo(0.03);
  });

  test("returns actionable guidance when vector index is unavailable", async () => {
    const vectorIndex: VectorIndexPort = {
      searchAvailable: false,
      model: "test-model",
      dimensions: 3,
      loadError: "sqlite-vec failed to load",
      guidance: "Run `gno doctor` for sqlite-vec diagnostics.",
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async () => {
        throw new Error("should not search when unavailable");
      },
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };

    const result = await searchVectorWithEmbedding(
      {
        store: {} as StorePort,
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: {} as Config,
      },
      "vector query",
      new Float32Array([0.1, 0.2, 0.3]),
      { limit: 5 }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("VEC_SEARCH_UNAVAILABLE");
    expect(result.error.message).toContain("sqlite-vec failed to load");
    expect(result.error.message).toContain("gno doctor");
  });

  test("uses getDocumentsByMirrorHashes and never listDocuments", async () => {
    const captured: { hashes: string[]; activeOnly?: boolean } = { hashes: [] };

    const store: Partial<StorePort> = {
      listDocuments: () => {
        throw new Error("N+1 detected: listDocuments should not be called");
      },
      getDocumentsByMirrorHashes: async (hashes, options) => {
        captured.hashes = hashes;
        captured.activeOnly = options?.activeOnly;
        return {
          ok: true as const,
          value: [makeDoc(1, "hash_1")],
        };
      },
      getCollections: async () => ({
        ok: true as const,
        value: TEST_COLLECTIONS,
      }),
      getChunksBatch: async (hashes) => {
        const map = new Map<string, ChunkRow[]>();
        for (const hash of hashes) {
          map.set(hash, [makeChunk(hash, 0), makeChunk(hash, 1)]);
        }
        return { ok: true as const, value: map };
      },
    };

    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async () => ({
        ok: true as const,
        value: [
          { mirrorHash: "hash_1", seq: 0, distance: 0.1 },
          { mirrorHash: "hash_1", seq: 1, distance: 0.2 },
          { mirrorHash: "hash_2", seq: 0, distance: 0.3 },
        ],
      }),
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };

    const embedPort = {} as EmbeddingPort;
    const config = {} as Config;

    const result = await searchVectorWithEmbedding(
      {
        store: store as StorePort,
        vectorIndex,
        embedPort,
        config,
      },
      "vector query",
      new Float32Array([0.1, 0.2, 0.3]),
      { limit: 5 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Deduped vector hashes are passed to targeted lookup.
    expect(captured.hashes).toEqual(["hash_1", "hash_2"]);
    expect(captured.activeOnly).toBe(true);

    // hash_2 has no document row; it should be filtered out.
    expect(result.value.results).toHaveLength(2);
    expect(result.value.results[0]?.docid).toBe("#hash_1");
    expect(result.value.results[1]?.docid).toBe("#hash_1");
  });

  test("sorts newest-first for recency intent using doc date fallback", async () => {
    const store: Partial<StorePort> = {
      listDocuments: () => {
        throw new Error("N+1 detected: listDocuments should not be called");
      },
      getDocumentsByMirrorHashes: async () => ({
        ok: true as const,
        value: [
          makeDoc(1, "hash_old", {
            sourceMtime: "2025-01-01T00:00:00.000Z",
            frontmatterDate: "2025-01-01T00:00:00.000Z",
          }),
          makeDoc(2, "hash_new", {
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

    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ({ ok: true, value: undefined }),
      deleteVectorsForMirror: async () => ({ ok: true, value: undefined }),
      searchNearest: async () => ({
        ok: true as const,
        value: [
          { mirrorHash: "hash_old", seq: 0, distance: 0.01 },
          { mirrorHash: "hash_new", seq: 0, distance: 0.2 },
        ],
      }),
      rebuildVecIndex: async () => ({ ok: true, value: undefined }),
      syncVecIndex: async () => ({ ok: true, value: { added: 0, removed: 0 } }),
    };

    const result = await searchVectorWithEmbedding(
      {
        store: store as StorePort,
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: {} as Config,
      },
      "latest notes",
      new Float32Array([0.1, 0.2, 0.3]),
      { limit: 2 }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.results).toHaveLength(2);
    expect(result.value.results[0]?.source.relPath).toBe("hash_new.md");
    expect(result.value.results[1]?.source.relPath).toBe("hash_old.md");
  });
});
