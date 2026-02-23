/**
 * N+1 regression tests for vector search pipeline.
 * Ensures we use targeted document lookups and avoid full document scans.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type {
  ChunkRow,
  CollectionRow,
  DocumentRow,
  StorePort,
} from "../../src/store/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";

const NOW = "2026-02-22T00:00:00.000Z";

const makeDoc = (id: number, mirrorHash: string): DocumentRow => ({
  id,
  collection: "notes",
  relPath: `${mirrorHash}.md`,
  sourceHash: `source_${mirrorHash}`,
  sourceMime: "text/markdown",
  sourceExt: ".md",
  sourceSize: 100,
  sourceMtime: NOW,
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
});
