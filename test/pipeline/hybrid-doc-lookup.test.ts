/**
 * Regression tests for hybrid search document lookup path.
 * Ensures targeted doc fetch is used instead of full scans.
 */

import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type {
  ChunkRow,
  CollectionRow,
  DocumentRow,
  FtsResult,
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
        genPort: null,
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
        genPort: null,
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
});
