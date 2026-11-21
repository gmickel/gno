import { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, test } from "bun:test";
// Bun has no directory-creation, sync stat, file-write, or OS/path equivalents.
import { statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort, GenerationPort } from "../../src/llm/types";
import type {
  ChunkRow,
  DocumentRow,
  FtsResult,
  StorePort,
  StoreResult,
} from "../../src/store/types";
import type {
  VectorIndexPort,
  VectorSearchResult,
} from "../../src/store/vector/types";

import { sha256Text } from "../../src/core/context-capsule-validation";
import { verifyContextCapsule } from "../../src/core/context-verifier";
import { lazyGenerationPort } from "../../src/llm/lazy-ports";
import { generateGroundedAnswer } from "../../src/pipeline/answer";
import {
  applySemanticJudgments,
  prepareClaimVerification,
  verifyClaimsDeterministically,
} from "../../src/pipeline/claim-verification";
import { verifyClaimsSemantically } from "../../src/pipeline/claim-verifier";
import { attachSearchResultEgressLineage } from "../../src/pipeline/egress-lineage";
import {
  compileExcludeTerms,
  matchesExcludedChunks,
  matchesExcludedText,
} from "../../src/pipeline/exclude";
import {
  expandQueryCached,
  generateCacheKey,
} from "../../src/pipeline/expansion";
import { compileDocumentFilters } from "../../src/pipeline/filters";
import { expandGraphCandidates } from "../../src/pipeline/graph-retrieval";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { RequestHydration } from "../../src/pipeline/hydration";
import {
  extractSteeringTerms,
  selectBestChunkForSteering,
} from "../../src/pipeline/intent";
import { resolveFusionOwners } from "../../src/pipeline/owner-fusion";
import { searchBm25 } from "../../src/pipeline/search";
import {
  cleanDisplaySnippet,
  isFrontmatterDominatedSnippet,
} from "../../src/pipeline/snippet";
import {
  compileTemporalRange,
  isWithinTemporalRange,
} from "../../src/pipeline/temporal";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { err, ok } from "../../src/store/types";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import {
  searchVectorVariants,
  searchVectorVariantsBatch,
} from "../../src/store/vector/variant-search";
import { createVectorVariantStore } from "../../src/store/vector/variants";
import {
  capsuleFor,
  createVerifierStore,
  verifierDeps,
  verifierFixture,
} from "../core/context-verifier-fixture";
import { safeRm } from "../helpers/cleanup";

const NOW = "2026-11-20T00:00:00.000Z";
const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await safeRm(dir);
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const TEST_CONFIG: Config = {
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

function makeDoc(
  id: number,
  overrides: Partial<DocumentRow> = {}
): DocumentRow {
  const mirrorHash = overrides.mirrorHash ?? `hash-${id}`;
  return {
    id,
    collection: "notes",
    relPath: `doc-${id}.md`,
    sourceHash: `src-${id}`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 128,
    sourceMtime: NOW,
    sourceCtime: NOW,
    docid: `#doc${id}`,
    uri: `gno://notes/doc-${id}.md`,
    title: `Doc ${id}`,
    mirrorHash,
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
    createdAt: NOW,
    updatedAt: NOW,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    ingestVersion: 1,
    ...overrides,
  };
}

function makeChunk(
  seq: number,
  text: string,
  mirrorHash = "hash-default",
  overrides: Partial<ChunkRow> = {}
): ChunkRow {
  return {
    mirrorHash,
    seq,
    pos: seq * 100,
    text,
    startLine: seq * 10 + 1,
    endLine: seq * 10 + 5,
    language: "en",
    tokenCount: 12,
    createdAt: NOW,
    ...overrides,
  };
}

function makeFts(id: number, score = -1.5, seq = 0): FtsResult {
  return {
    docid: `#doc${id}`,
    uri: `gno://notes/doc-${id}.md`,
    title: `Doc ${id}`,
    collection: "notes",
    relPath: `doc-${id}.md`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceMtime: NOW,
    mirrorHash: `hash-${id}`,
    seq,
    score,
    contentType: "note",
  };
}

describe("R1: Deduplicated BM25 and fail-fast INVALID_INPUT in hybrid search", () => {
  test("fails fast on FTS INVALID_INPUT without invoking expandPort", async () => {
    const expandGenerate = mock(async () =>
      ok(JSON.stringify({ lexicalQueries: ["fallback"], vectorQueries: [] }))
    );
    const expandPort = {
      modelUri: "hf:test/expand.gguf",
      generate: expandGenerate,
      dispose: async () => undefined,
    } as unknown as GenerationPort;

    const searchFts = mock(async () =>
      err("INVALID_INPUT", "Malformed FTS5 syntax")
    );
    const store = {
      searchFts,
      getCollections: async () => ok([]),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex: null,
        embedPort: null,
        expandPort,
        rerankPort: null,
      },
      '"unclosed quote'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    expect(searchFts).toHaveBeenCalledTimes(1);
    expect(expandGenerate).toHaveBeenCalledTimes(0);
  });

  test("executes original FTS query once and reuses results when lexical expansion matches query.trim()", async () => {
    const ftsQueries: string[] = [];
    const docs = [makeDoc(1), makeDoc(2)];
    const chunks = new Map<string, ChunkRow[]>([
      ["hash-1", [makeChunk(0, "latency budget overview", "hash-1")]],
      ["hash-2", [makeChunk(0, "latency budget tuning", "hash-2")]],
    ]);
    const searchFts = mock(async (q: string) => {
      ftsQueries.push(q);
      // Weak BM25 gap so expansion runs.
      return ok([makeFts(1, -1.0), makeFts(2, -0.95)]);
    });
    const expandPort = {
      modelUri: "hf:test/expand.gguf",
      generate: async () =>
        ok(
          JSON.stringify({
            lexicalQueries: ["latency budget", "latency budget tuning"],
            vectorQueries: ["query latency budget"],
          })
        ),
      dispose: async () => undefined,
    } as unknown as GenerationPort;

    const store = {
      searchFts,
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getDocumentsByMirrorHashes: async () => ok(docs),
      getChunksBatch: async () => ok(chunks),
      getChunksBySequenceBatch: async () => ok(chunks),
      getTagsBatch: async () => ok(new Map()),
      getContentBatch: async () => ok(new Map()),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex: null,
        embedPort: null,
        expandPort,
        rerankPort: null,
      },
      "  latency budget  ",
      { limit: 5 }
    );

    expect(result.ok).toBe(true);
    // Original query runs once; identical trimmed lexical variant reuses it;
    // only the distinct lexical variant triggers a second FTS5 call.
    expect(ftsQueries).toEqual(["  latency budget  ", "latency budget tuning"]);
  });
});

describe("R2: Clean-mirror vec0 fast path, boundary ties, zero vectors, and searchVectorVariantsBatch", () => {
  test("vec0 fast path and searchVectorVariantsBatch match vector_variants across clean, tied, zero-vector, dirty, and filtered queries", async () => {
    const dir = await makeTempDir("gno-vec0-r2-");
    const dbPath = join(dir, "index.sqlite");
    const adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
    let db: Database | undefined;
    try {
      expect(
        (
          await adapter.syncCollections([
            {
              name: "alpha",
              path: join(dir, "alpha"),
              pattern: "**/*",
              include: [],
              exclude: [],
            },
            {
              name: "beta",
              path: join(dir, "beta"),
              pattern: "**/*",
              include: [],
              exclude: [],
            },
          ])
        ).ok
      ).toBe(true);

      const dims = 4;
      const identity = {
        model: "test-embed-model",
        modelFingerprint: "fp-v1",
        contextSize: 512,
        truncationPolicy: "tail-v1",
        dimensions: dims,
      };

      const specs = [
        {
          collection: "alpha",
          relPath: "a.md",
          mirrorHash: "mh-a",
          text: "alpha one",
          vec: new Float32Array([1, 0, 0, 0]),
        },
        {
          collection: "alpha",
          relPath: "b.md",
          mirrorHash: "mh-b",
          text: "alpha tie one",
          vec: new Float32Array([0.8, 0.6, 0, 0]),
        },
        {
          collection: "beta",
          relPath: "c.md",
          mirrorHash: "mh-c",
          text: "beta tie two",
          vec: new Float32Array([0.8, 0.6, 0, 0]),
        },
        {
          collection: "beta",
          relPath: "d.md",
          mirrorHash: "mh-d",
          text: "beta ortho",
          vec: new Float32Array([0, 1, 0, 0]),
        },
      ];

      const vecByMirror = new Map(specs.map((s) => [s.mirrorHash, s.vec]));
      for (const spec of specs) {
        const up = await adapter.upsertDocument({
          collection: spec.collection,
          relPath: spec.relPath,
          sourceHash: `src-${spec.mirrorHash}`,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: spec.text.length,
          sourceMtime: NOW,
          title: spec.relPath,
          mirrorHash: spec.mirrorHash,
        });
        if (!up.ok) throw new Error(up.error.message);
        expect(
          (await adapter.upsertContent(spec.mirrorHash, spec.text)).ok
        ).toBe(true);
        expect(
          (
            await adapter.upsertChunks(spec.mirrorHash, [
              { seq: 0, pos: 0, text: spec.text, startLine: 1, endLine: 1 },
            ])
          ).ok
        ).toBe(true);
      }

      db = new Database(dbPath);
      const created = await createVectorIndexPort(db, {
        model: identity.model,
        dimensions: dims,
      });
      expect(created.ok).toBe(true);
      const vstore = await createVectorVariantStore(db, identity);
      const pending = vstore.pending({ limit: 100 });
      vstore.write(
        pending.map((owner) => ({
          owner,
          embedding: vecByMirror.get(owner.mirrorHash)!,
        }))
      );
      vstore.activate(vstore.epoch());
      const partitionId = vstore.partitionId;

      // Mirror is clean after activate()
      const q1 = new Float32Array([1, 0, 0, 0]);
      const q2 = new Float32Array([0, 1, 0, 0]);

      // Clean mirror (vec0 fast path), including boundary distance tie at k=2 (mh-b vs mh-c).
      const cleanSingle = searchVectorVariants(
        db,
        identity.model,
        dims,
        q1,
        2,
        { partitionId }
      );
      const cleanBatch = searchVectorVariantsBatch(
        db,
        identity.model,
        dims,
        [q1, q2],
        [2, 2],
        { partitionId }
      );
      expect(cleanSingle).not.toBeNull();
      expect(cleanBatch).not.toBeNull();

      // Filtered multi-query single-pass scan (collection = "alpha").
      const filteredSingle1 = searchVectorVariants(
        db,
        identity.model,
        dims,
        q1,
        3,
        { partitionId, eligibility: { collection: "alpha" } }
      );
      const filteredSingle2 = searchVectorVariants(
        db,
        identity.model,
        dims,
        q2,
        3,
        { partitionId, eligibility: { collection: "alpha" } }
      );
      const filteredBatch = searchVectorVariantsBatch(
        db,
        identity.model,
        dims,
        [q1, q2],
        [3, 3],
        { partitionId, eligibility: { collection: "alpha" } }
      );
      expect(filteredBatch).toEqual([filteredSingle1!, filteredSingle2!]);

      // Mark mirror dirty to force vector_variants oracle path and compare bit-for-bit.
      db.query(
        "UPDATE vector_mirror_state SET dirty = 1 WHERE partition_id = ?"
      ).run(partitionId);
      const dirtySingle1 = searchVectorVariants(
        db,
        identity.model,
        dims,
        q1,
        2,
        { partitionId }
      );
      const dirtySingle2 = searchVectorVariants(
        db,
        identity.model,
        dims,
        q2,
        2,
        { partitionId }
      );
      const dirtyBatch = searchVectorVariantsBatch(
        db,
        identity.model,
        dims,
        [q1, q2],
        [2, 2],
        { partitionId }
      );
      expect(cleanSingle).toEqual(dirtySingle1);
      expect(cleanBatch).toEqual([dirtySingle1!, dirtySingle2!]);
      expect(dirtyBatch).toEqual([dirtySingle1!, dirtySingle2!]);
      // Tie at k=2 must break deterministically by mirrorHash ("mh-b" before "mh-c").
      expect(cleanSingle!.map((r) => r.mirrorHash)).toEqual(["mh-a", "mh-b"]);

      // Zero-vector stored variant triggers NULL-cosine fallback parity with clean mirror.
      const zeroUp = await adapter.upsertDocument({
        collection: "alpha",
        relPath: "zero.md",
        sourceHash: "src-mh-zero",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 4,
        sourceMtime: NOW,
        title: "zero.md",
        mirrorHash: "mh-zero",
      });
      if (!zeroUp.ok) throw new Error(zeroUp.error.message);
      await adapter.upsertContent("mh-zero", "zero");
      await adapter.upsertChunks("mh-zero", [
        { seq: 0, pos: 0, text: "zero", startLine: 1, endLine: 1 },
      ]);
      const zeroPending = vstore.pending({ limit: 100 });
      vstore.write(
        zeroPending.map((owner) => ({
          owner,
          embedding: new Float32Array([0, 0, 0, 0]),
        }))
      );
      vstore.activate(vstore.epoch());

      const cleanWithZero = searchVectorVariants(
        db,
        identity.model,
        dims,
        q1,
        3,
        { partitionId }
      );
      db.query(
        "UPDATE vector_mirror_state SET dirty = 1 WHERE partition_id = ?"
      ).run(partitionId);
      const dirtyWithZero = searchVectorVariants(
        db,
        identity.model,
        dims,
        q1,
        3,
        { partitionId }
      );
      expect(cleanWithZero).toEqual(dirtyWithZero);
    } finally {
      db?.close();
      await adapter.close();
    }
  });

  test("deduplicates identical formatted query strings in expanded vector batches and calls searchNearestBatch once", async () => {
    const embedBatch = mock(async (texts: string[]) =>
      ok(texts.map((_, i) => [1, i + 0.1, 0.2]))
    );
    const searchNearestBatch = mock(
      async (embeddings: Float32Array[], _limits: number[]) =>
        ok(
          embeddings.map(() => [
            { mirrorHash: "hash-1", seq: 0, distance: 0.1 },
          ])
        )
    );
    const searchNearest = mock(async () =>
      ok([{ mirrorHash: "hash-1", seq: 0, distance: 0.1 }])
    );

    const embedPort = {
      modelUri:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      init: async () => ok(undefined),
      dimensions: () => 3,
      dispose: async () => undefined,
      embed: async () => ok([1, 0, 0]),
      embedBatch,
    } as unknown as EmbeddingPort;

    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: embedPort.modelUri,
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ok(undefined),
      deleteVectorsForMirror: async () => ok(undefined),
      rebuildVecIndex: async () => ok(undefined),
      syncVecIndex: async () => ok({ added: 0, removed: 0 }),
      searchNearest,
      searchNearestBatch,
    };

    const store = {
      searchFts: async () => ok([]),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getDocumentsByMirrorHashes: async () => ok([makeDoc(1)]),
      getChunksBatch: async () =>
        ok(
          new Map([["hash-1", [makeChunk(0, "dedup query content", "hash-1")]]])
        ),
      getChunksBySequenceBatch: async () =>
        ok(
          new Map([["hash-1", [makeChunk(0, "dedup query content", "hash-1")]]])
        ),
      getTagsBatch: async () => ok(new Map()),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "duplicate query",
      {
        queryModes: [
          { mode: "intent", text: "duplicate query" },
          { mode: "intent", text: "distinct variant" },
        ],
      }
    );

    expect(result.ok).toBe(true);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    // Original query + duplicate intent mode collapse into 1 formatted string, plus 1 distinct = 2 unique embeddings.
    expect(embedBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(searchNearestBatch).toHaveBeenCalledTimes(1);
    expect(searchNearestBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(searchNearest).toHaveBeenCalledTimes(0);
  });
});

describe("R3: Deterministic llm_cache wiring for expandQueryCached", () => {
  test("generateCacheKey reflects contextSize, modelFingerprint, and local file mtime/size", async () => {
    const dir = await makeTempDir("gno-exp-key-");
    const modelPath = join(dir, "model.gguf");
    await writeFile(modelPath, "v1-weights");
    const fileUri = `file:${modelPath}`;

    const k1 = generateCacheKey(
      "hf:test/expand.gguf",
      "query",
      "en",
      undefined,
      {
        contextSize: 2048,
        modelFingerprint: "fp-a",
      }
    );
    const k2 = generateCacheKey(
      "hf:test/expand.gguf",
      "query",
      "en",
      undefined,
      {
        contextSize: 4096,
        modelFingerprint: "fp-a",
      }
    );
    const k3 = generateCacheKey(
      "hf:test/expand.gguf",
      "query",
      "en",
      undefined,
      {
        contextSize: 2048,
        modelFingerprint: "fp-b",
      }
    );
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);

    const f1 = generateCacheKey(fileUri, "query", "en", undefined, {
      contextSize: 2048,
    });
    // Modifying the file size changes the cached key when no explicit fingerprint is provided.
    await writeFile(modelPath, "v2-longer-weights-payload");
    const f2 = generateCacheKey(fileUri, "query", "en", undefined, {
      contextSize: 2048,
    });
    expect(f1).not.toBe(f2);
  });

  test("SqliteAdapter getLlmCache/setLlmCache roundtrip, expiry, read-only no-op, and searchHybrid counters", async () => {
    const dir = await makeTempDir("gno-llm-cache-");
    const dbPath = join(dir, "index.sqlite");
    const adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
    try {
      expect(
        (
          await adapter.syncCollections([
            {
              name: "notes",
              path: join(dir, "notes"),
              pattern: "**/*",
              include: [],
              exclude: [],
            },
          ])
        ).ok
      ).toBe(true);
      // Seed two nearly-tied docs so hasStrongBm25Signal is false and expansion runs.
      for (const [name, body] of [
        ["doc1.md", "expansion cache target note alpha"],
        ["doc2.md", "expansion cache target note beta"],
      ] as const) {
        const mh = `mh-${name}`;
        await adapter.upsertDocument({
          collection: "notes",
          relPath: name,
          sourceHash: `src-${name}`,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: body.length,
          sourceMtime: NOW,
          title: name,
          mirrorHash: mh,
        });
        await adapter.upsertContent(mh, body);
        await adapter.upsertChunks(mh, [
          { seq: 0, pos: 0, text: body, startLine: 1, endLine: 1 },
        ]);
        await adapter.syncDocumentFts("notes", name);
      }

      // Expiry check
      expect(
        (
          await adapter.setLlmCache(
            "expired-key",
            "stale",
            "2000-01-01 00:00:00"
          )
        ).ok
      ).toBe(true);
      const expired = await adapter.getLlmCache("expired-key");
      expect(expired).toEqual(ok(null));

      // Hybrid search wires expandQueryCached: first call misses & stores, second hits without LLM call.
      const modelPath = join(dir, "expand-v1.gguf");
      await writeFile(modelPath, "gguf-v1-bytes");
      const generate = mock(async () =>
        ok(
          JSON.stringify({
            lexicalQueries: ["expansion cache", "expansion cache note"],
            vectorQueries: ["expansion cache note"],
          })
        )
      );
      const expandPort = {
        modelUri: "hf:test/expand.gguf",
        modelPath,
        generate,
        dispose: async () => undefined,
      } as unknown as GenerationPort;

      const first = await searchHybrid(
        {
          store: adapter,
          config: TEST_CONFIG,
          vectorIndex: null,
          embedPort: null,
          expandPort,
          rerankPort: null,
        },
        "expansion cache",
        { explain: true, noExpand: false }
      );
      expect(first.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      if (first.ok) {
        const counterLine = first.value.meta.explain?.lines.find(
          (line) => line.stage === "counters"
        );
        expect(counterLine?.message).toContain("expansionCache=0/1");
      }

      const second = await searchHybrid(
        {
          store: adapter,
          config: TEST_CONFIG,
          vectorIndex: null,
          embedPort: null,
          expandPort,
          rerankPort: null,
        },
        "expansion cache",
        { explain: true, noExpand: false }
      );
      expect(second.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      if (second.ok) {
        const counterLine = second.value.meta.explain?.lines.find(
          (line) => line.stage === "counters"
        );
        expect(counterLine?.message).toContain("expansionCache=1/1");
      }

      // F4: Replacing the local GGUF behind an hf: URI invalidates cached entries.
      await writeFile(modelPath, "gguf-v2-replaced-longer-weights");
      const afterModelReplace = await searchHybrid(
        {
          store: adapter,
          config: TEST_CONFIG,
          vectorIndex: null,
          embedPort: null,
          expandPort,
          rerankPort: null,
        },
        "expansion cache",
        { explain: true, noExpand: false }
      );
      expect(afterModelReplace.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(2);
      if (afterModelReplace.ok) {
        const counterLine = afterModelReplace.value.meta.explain?.lines.find(
          (line) => line.stage === "counters"
        );
        expect(counterLine?.message).toContain("expansionCache=0/1");
      }

      // F4: hf: port with no modelPath/modelFingerprint skips persistent caching.
      const unidentifiablePort = {
        modelUri: "hf:test/unidentified.gguf",
        generate,
        dispose: async () => undefined,
      } as unknown as GenerationPort;
      await expandQueryCached(
        {
          genPort: unidentifiablePort,
          getCache: async (k) => {
            const r = await adapter.getLlmCache(k);
            return r.ok ? r.value : null;
          },
          setCache: async (k, v) => {
            await adapter.setLlmCache(k, v);
          },
        },
        "unidentified model query",
        { lang: "en", contextSize: 2048 }
      );
      expect(generate).toHaveBeenCalledTimes(3);

      // F5: Structurally corrupt JSON (valid JSON but non-string array items) counts as a miss.
      const cacheKey = generateCacheKey(
        "hf:test/expand.gguf",
        "corrupt cache query",
        "en",
        undefined,
        { contextSize: 2048, modelPath }
      );
      await adapter.setLlmCache(
        cacheKey,
        JSON.stringify({ lexicalQueries: [null], vectorQueries: [42] })
      );
      let corruptHits = 0;
      const corruptRes = await expandQueryCached(
        {
          genPort: expandPort,
          getCache: async (k) => {
            const r = await adapter.getLlmCache(k);
            return r.ok ? r.value : null;
          },
          setCache: async (k, v) => {
            await adapter.setLlmCache(k, v);
          },
          onCacheHit: () => {
            corruptHits += 1;
          },
        },
        "corrupt cache query",
        { lang: "en", contextSize: 2048 }
      );
      expect(corruptRes.ok).toBe(true);
      expect(corruptHits).toBe(0);
      expect(generate).toHaveBeenCalledTimes(4);
    } finally {
      await adapter.close();
    }

    // Read-only SQLite database: setLlmCache silently no-ops and returns ok(undefined).
    const roDb = new Database(dbPath, { readonly: true });
    try {
      const roAdapter = new SqliteAdapter();
      (roAdapter as unknown as { db: Database }).db = roDb;
      const writeRes = await roAdapter.setLlmCache("ro-key", "value");
      expect(writeRes).toEqual(ok(undefined));
    } finally {
      roDb.close();
    }
  });
});

describe("R4: Per-request document hydration caching and owner-fusion batching", () => {
  test("RequestHydration caches documents per (scopeKey, mirrorHash), sorts merged rows by id ASC, and freezes flat ChunkRows", async () => {
    const calls: string[][] = [];
    const store = {
      getDocumentsByMirrorHashes: async (hashes: string[]) => {
        calls.push([...hashes]);
        const docs: DocumentRow[] = [];
        if (hashes.includes("h1")) docs.push(makeDoc(1, { mirrorHash: "h1" }));
        if (hashes.includes("h2")) docs.push(makeDoc(2, { mirrorHash: "h2" }));
        if (hashes.includes("h3")) docs.push(makeDoc(3, { mirrorHash: "h3" }));
        return ok(docs);
      },
      getChunksBatch: async (hashes: string[]) =>
        ok(
          new Map(
            hashes.map((h) => [h, [makeChunk(0, `chunk text for ${h}`, h)]])
          )
        ),
      getContentBatch: async (hashes: string[]) =>
        ok(new Map(hashes.map((h) => [h, `content for ${h}`]))),
    } as unknown as StorePort;

    const hydration = new RequestHydration(store);
    try {
      const first = await hydration.getDocumentsByMirrorHashes(["h1", "h3"]);
      expect(first.ok).toBe(true);
      // Subset hit makes 0 additional store calls.
      const subset = await hydration.getDocumentsByMirrorHashes(["h3"]);
      expect(subset.ok).toBe(true);
      expect(calls).toEqual([["h1", "h3"]]);

      // Partial miss fetches ONLY "h2" and merges sorted by id ASC (1, 2, 3).
      const merged = await hydration.getDocumentsByMirrorHashes([
        "h3",
        "h2",
        "h1",
      ]);
      expect(calls).toEqual([["h1", "h3"], ["h2"]]);
      expect(merged.ok).toBe(true);
      if (merged.ok) {
        expect(merged.value.map((d) => d.id)).toEqual([1, 2, 3]);
      }

      // ChunkRow snapshot is frozen; string content returns directly.
      const chunkRes = await hydration.getChunksBatch(["h1"]);
      expect(chunkRes.ok).toBe(true);
      if (chunkRes.ok) {
        const list = chunkRes.value.get("h1")!;
        expect(Object.isFrozen(list)).toBe(true);
        expect(Object.isFrozen(list[0])).toBe(true);
        expect(hydration.hasChunks("h1")).toBe(true);
        expect(hydration.hasChunks("missing")).toBe(false);
      }

      const contentRes = await hydration.getContentBatch(["h1"]);
      expect(contentRes.ok && contentRes.value.get("h1")).toBe(
        "content for h1"
      );
    } finally {
      hydration.release();
    }
  });

  test("resolveFusionOwners batches tags via getTagsBatch (0 getTagsForDoc calls) and supports forceResolve for graph input", async () => {
    const getTagsForDoc = mock(async () => ok([]));
    const getTagsBatch = mock(async (ids: number[]) =>
      ok(
        new Map(
          ids.map((id) => [id, [{ tag: "perf", source: "user" as const }]])
        )
      )
    );
    const store = {
      getDocumentsByMirrorHashes: async () =>
        ok([
          makeDoc(1, { mirrorHash: "h1" }),
          makeDoc(2, { mirrorHash: "h2" }),
        ]),
      getChunksBatch: async () =>
        ok(
          new Map([
            ["h1", [makeChunk(0, "alpha", "h1")]],
            ["h2", [makeChunk(0, "beta", "h2")]],
          ])
        ),
      getTagsForDoc,
      getTagsBatch,
    } as unknown as StorePort;

    const hydration = new RequestHydration(store);
    try {
      const graphInput = {
        results: [{ mirrorHash: "h2", seq: 0, rank: 1, sourceDocid: "#doc2" }],
        weight: 0.4,
        source: "graph" as const,
      };
      // Without forceResolve, a graph input without documentId is left untouched.
      const untouched = await resolveFusionOwners(
        [graphInput],
        store,
        hydration,
        "alpha",
        { tagsAll: ["perf"] }
      );
      expect(untouched[0]?.results[0]?.documentId).toBeUndefined();
      expect(getTagsBatch).toHaveBeenCalledTimes(0);

      // With forceResolve = true, owners are resolved via batched tags (0 per-doc calls).
      const resolved = await resolveFusionOwners(
        [graphInput],
        store,
        hydration,
        "alpha",
        { tagsAll: ["perf"] },
        true
      );
      expect(resolved[0]?.results).toEqual([
        {
          mirrorHash: "h2",
          seq: 0,
          rank: 1,
          sourceDocid: "#doc2",
          documentId: 2,
        },
      ]);
      expect(getTagsBatch).toHaveBeenCalledTimes(1);
      expect(getTagsForDoc).toHaveBeenCalledTimes(0);
    } finally {
      hydration.release();
    }
  });
});

describe("R5: Deferred --full content fetches, title-only BM25 fallback, sequence-scoped hybrid chunks, and paginated graph hydration", () => {
  test("searchBm25 and searchVectorWithEmbedding defer --full getContentBatch to surviving limit hashes only", async () => {
    const bm25ContentBatches: string[][] = [];
    const vecContentBatches: string[][] = [];
    const docs = [makeDoc(1), makeDoc(2), makeDoc(3), makeDoc(4)];
    const chunks = new Map(
      docs.map((d) => [
        d.mirrorHash!,
        [makeChunk(0, `body ${d.id}`, d.mirrorHash!)],
      ])
    );

    const makeMockStore = (batches: string[][]): StorePort =>
      ({
        searchFts: async () =>
          ok([makeFts(1, -4), makeFts(2, -3), makeFts(3, -2), makeFts(4, -1)]),
        getCollections: async () =>
          ok([
            {
              name: "notes",
              path: "/notes",
              egressPolicy: "local_only",
              egressPolicySource: "legacy_default",
            },
          ]),
        getDocumentsByMirrorHashes: async () => ok(docs),
        getChunksBatch: async () => ok(chunks),
        getChunksBySequenceBatch: async (
          keys: Array<{ mirrorHash: string; seq: number }>
        ) =>
          ok(
            new Map(
              keys.map((k) => [k.mirrorHash, chunks.get(k.mirrorHash) ?? []])
            )
          ),
        getContentBatch: async (hashes: string[]) => {
          batches.push([...hashes]);
          return ok(new Map(hashes.map((h) => [h, `full content ${h}`])));
        },
        getTagsBatch: async () => ok(new Map()),
      }) as unknown as StorePort;

    const bm25 = await searchBm25(makeMockStore(bm25ContentBatches), "body", {
      full: true,
      limit: 2,
    });
    expect(bm25.ok).toBe(true);
    expect(bm25ContentBatches).toHaveLength(1);
    expect(bm25ContentBatches[0]).toHaveLength(2);
    if (bm25.ok) {
      expect(bm25.value.results.map((r) => r.snippet)).toEqual([
        "full content hash-1",
        "full content hash-2",
      ]);
    }

    const vectorIndex = {
      searchAvailable: true,
      searchNearest: async () =>
        ok([
          { mirrorHash: "hash-1", seq: 0, distance: 0.1 },
          { mirrorHash: "hash-2", seq: 0, distance: 0.2 },
          { mirrorHash: "hash-3", seq: 0, distance: 0.3 },
          { mirrorHash: "hash-4", seq: 0, distance: 0.4 },
        ]),
    } as unknown as VectorIndexPort;
    const vec = await searchVectorWithEmbedding(
      {
        store: makeMockStore(vecContentBatches),
        vectorIndex,
        embedPort: {} as EmbeddingPort,
        config: TEST_CONFIG,
      },
      "body",
      new Float32Array([1, 0, 0]),
      { full: true, limit: 2 }
    );
    expect(vec.ok).toBe(true);
    expect(vecContentBatches).toHaveLength(1);
    expect(vecContentBatches[0]).toHaveLength(2);
    if (vec.ok) {
      expect(vec.value.results.map((r) => r.snippet)).toEqual([
        "full content hash-1",
        "full content hash-2",
      ]);
    }
  });

  test("searchBm25 default mode falls back to seq-0 chunk once when query only matches title", async () => {
    const seqCalls: Array<Array<{ mirrorHash: string; seq: number }>> = [];
    const store = {
      searchFts: async () => ok([makeFts(1, -2.0, 0)]),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getChunkTermPresence: async () => ok([]),
      getChunksBySequenceBatch: async (
        keys: Array<{ mirrorHash: string; seq: number }>
      ) => {
        seqCalls.push(keys);
        return ok(
          new Map([
            ["hash-1", [makeChunk(0, "Body without title token", "hash-1")]],
          ])
        );
      },
      getChunksBatch: async () => ok(new Map()),
    } as unknown as StorePort;

    const result = await searchBm25(store, "unmatched-title-term", {
      limit: 5,
    });
    expect(result.ok).toBe(true);
    expect(seqCalls).toHaveLength(1);
    if (result.ok) {
      expect(result.value.results[0]?.snippet).toBe("Body without title token");
      expect(result.value.results[0]?.snippetRange).toEqual({
        startLine: 1,
        endLine: 5,
      });
    }
  });

  test("expandGraphCandidates paginates neighbor hydration and stops once maxCandidates survive", async () => {
    const hydratedBatches: string[][] = [];
    const neighborIds = Array.from({ length: 12 }, (_, idx) => idx + 2);
    const store = {
      getDocumentsByMirrorHashes: async (hashes: string[]) => {
        hydratedBatches.push([...hashes]);
        return ok(
          hashes.map((h) => {
            const id = Number(h.replace("hash-", ""));
            return makeDoc(id, { mirrorHash: h });
          })
        );
      },
      getDocumentsByDocids: async (docids: string[]) =>
        ok(
          docids.map((docid) => {
            const id = Number(docid.replace("#doc", ""));
            return makeDoc(id, { mirrorHash: `hash-${id}` });
          })
        ),
      getChunksBySequenceBatch: async (
        keys: Array<{ mirrorHash: string; seq: number }>
      ) =>
        ok(
          new Map(
            keys.map((k) => [
              k.mirrorHash,
              [makeChunk(0, `graph ${k.mirrorHash}`, k.mirrorHash)],
            ])
          )
        ),
      getChunksBatch: async () => ok(new Map()),
      getTagsBatch: async () => ok(new Map()),
      getGraphNeighborsForSeeds: async () =>
        ok({
          links: neighborIds.map((id) => ({
            source: "#doc1",
            target: `#doc${id}`,
            type: "wiki" as const,
            weight: 1,
          })),
          meta: {
            seedDocumentIds: [1],
            examinedLinkRows: neighborIds.length,
            returnedEdges: neighborIds.length,
          },
        }),
    } as unknown as StorePort;

    const hydration = new RequestHydration(store);
    try {
      const expanded = await expandGraphCandidates(
        store,
        [
          {
            mirrorHash: "hash-1",
            seq: 0,
            fusionScore: 1,
            bm25Rank: 1,
            vecRank: null,
            sources: ["bm25"],
          },
        ],
        { candidateLimit: 2 },
        hydration
      );
      expect(expanded.candidates).toHaveLength(2);
      // Seed lookup (1) + first page (maxCandidates * 3 = 6) = 7 < 13 total hashes.
      const totalNeighborHydrated = hydratedBatches
        .slice(1)
        .reduce((sum, batch) => sum + batch.length, 0);
      expect(totalNeighborHydrated).toBeLessThan(neighborIds.length);
    } finally {
      hydration.release();
    }
  });
});

describe("R6: Single-pass claim verification and O(J) judgment indexing", () => {
  test("prepareClaimVerification + applySemanticJudgments matches verifyClaimsDeterministically across valid, misquoted, duplicate, and mismatched judgments", async () => {
    const fixture = verifierFixture(false);
    const harness = createVerifierStore(fixture.state);
    const capsule = await capsuleFor(harness.store, fixture.state);
    const receipt = await verifyContextCapsule(
      capsule,
      verifierDeps(harness.store, capsule)
    );
    const ev = capsule.evidence[0]!;
    const mark = `[evidence:${ev.evidenceId}]`;
    // Extract a clean substring without sentence-terminating punctuation.
    const cleanQuote = ev.text
      .split(/\s+/)
      .slice(0, 3)
      .join(" ")
      .replace(/[.!?]+$/, "")
      .trim();
    const answer =
      `Source confirms "${cleanQuote}" ${mark}. ` +
      `Unquoted summary also holds ${mark}. ` +
      `Misquoted "completely fabricated sentence xyz" claim ${mark}.`;

    const prepared = prepareClaimVerification({
      capsule,
      answer,
      freshness: receipt,
    });
    const [c0, c1] = prepared.claims;
    const fp = sha256Text("verifier");
    const judgments = [
      {
        claimId: c0!.claim.claimId,
        verdict: "supported" as const,
        confidence: 0.95,
        evidenceIds: [ev.evidenceId],
        rationaleCode: "semantic_entailment" as const,
        verifierFingerprint: fp,
      },
      {
        claimId: c1!.claim.claimId,
        verdict: "supported" as const,
        confidence: 0.91,
        evidenceIds: [ev.evidenceId],
        rationaleCode: "semantic_entailment" as const,
        verifierFingerprint: fp,
      },
      {
        claimId: c1!.claim.claimId,
        verdict: "supported" as const,
        confidence: 0.91,
        evidenceIds: [ev.evidenceId],
        rationaleCode: "semantic_entailment" as const,
        verifierFingerprint: fp,
      },
    ];

    const viaSplit = applySemanticJudgments(prepared, judgments);
    const viaMonolith = verifyClaimsDeterministically({
      capsule,
      answer,
      freshness: receipt,
      semanticJudgments: judgments,
    });

    expect(viaSplit).toEqual(viaMonolith);
    expect(viaSplit.claims[0]?.status).toBe("supported");
    // Duplicate judgment on c1 forces uncertain status.
    expect(viaSplit.claims[1]?.status).toBe("uncertain");
    expect(viaSplit.claims[1]?.rationaleCode).toBe(
      "semantic_judgment_unavailable"
    );
    // Misquoted claim is deterministically rejected with quote_not_in_evidence.
    expect(viaSplit.claims[2]?.status).toBe("uncertain");
    expect(viaSplit.claims[2]?.rationaleCode).toBe("quote_not_in_evidence");
  });

  test("verifyClaimsSemantically prepares once and validates with semantic model output", async () => {
    const fixture = verifierFixture(false);
    const harness = createVerifierStore(fixture.state);
    const capsule = await capsuleFor(harness.store, fixture.state);
    const receipt = await verifyContextCapsule(
      capsule,
      verifierDeps(harness.store, capsule)
    );
    const ev = capsule.evidence[0]!;
    const answer = `Mina owns the decision [evidence:${ev.evidenceId}].`;
    const preliminary = verifyClaimsDeterministically({
      answer,
      capsule,
      freshness: receipt,
    });

    const genPort = {
      modelUri: "file:/models/verifier.gguf",
      structuredOutput: "json_schema" as const,
      generate: async () =>
        ok(
          JSON.stringify({
            judgments: [
              {
                claimId: preliminary.claims[0]!.claimId,
                verdict: "supported",
                confidence: 0.96,
                evidenceIds: [ev.evidenceId],
                rationaleCode: "semantic_entailment",
              },
            ],
            unresolvedClaimIds: [],
          })
        ),
      dispose: async () => undefined,
    } as unknown as GenerationPort;

    const result = await verifyClaimsSemantically({
      capsule,
      answer,
      freshness: receipt,
      genPort,
      configFingerprint: sha256Text("config"),
    });
    expect(result.semanticVerification.status).toBe("completed");
    expect(result.verification.claims[0]?.status).toBe("supported");
  });
});

describe("R7: Inner-loop filter, snippet, intent, temporal, exclude, and egress-lineage cleanups", () => {
  test("compiled filters, temporal empty-range fast path, pre-lowercased exclude, snippet fast-skip, single-chunk intent, and grouped egress lineage", async () => {
    // Temporal empty range fast path
    const emptyRange = compileTemporalRange({});
    expect(isWithinTemporalRange(undefined, emptyRange)).toBe(true);
    const bounded = compileTemporalRange({
      since: "2026-01-01T00:00:00Z",
      until: "2026-12-31T23:59:59Z",
    });
    expect(isWithinTemporalRange("2026-06-01T00:00:00Z", bounded)).toBe(true);
    expect(isWithinTemporalRange("2025-01-01T00:00:00Z", bounded)).toBe(false);

    // Pre-lowercased exclude terms
    const compiled = compileDocumentFilters("query", {
      exclude: ["Draft", "Deprecated"],
      author: "Alice",
      categories: ["Notes"],
    });
    expect(compiled.excludeTermsLower).toEqual(
      compileExcludeTerms(["Draft", "Deprecated"])
    );
    expect(
      matchesExcludedText(["DRAFT title"], compiled.excludeTermsLower!, true)
    ).toBe(true);
    expect(
      matchesExcludedChunks(
        [makeChunk(0, "contains DEPRECATED API")],
        compiled.excludeTermsLower!,
        true
      )
    ).toBe(true);
    expect(
      matchesExcludedChunks(
        [makeChunk(0, "clean active text")],
        compiled.excludeTermsLower!,
        true
      )
    ).toBe(false);

    // Snippet fast-skip without '-'
    expect(cleanDisplaySnippet("Plain prose without dashes").text).toBe(
      "Plain prose without dashes"
    );
    expect(isFrontmatterDominatedSnippet("Plain prose without dashes")).toBe(
      false
    );

    // Intent single-chunk fast return and hoisted terms
    const single = makeChunk(0, "only chunk");
    expect(
      selectBestChunkForSteering([single], "test", "focus", {
        intentWeight: 1.5,
        queryTerms: extractSteeringTerms("test"),
        intentTerms: extractSteeringTerms("focus"),
      })
    ).toBe(single);

    // Grouped egress lineage attaches accurate ownership across shared mirror hashes
    const docs = [
      makeDoc(1, { collection: "notes", mirrorHash: "shared-hash" }),
      makeDoc(2, { collection: "public", mirrorHash: "shared-hash" }),
    ];
    const store = {
      getDocumentsByMirrorHashes: async () => ok(docs),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
          {
            name: "public",
            path: "/public",
            egressPolicy: "remote",
            egressPolicySource: "explicit",
          },
        ]),
    } as unknown as StorePort;

    const searchResults = [
      {
        docid: "#doc2",
        uri: "gno://public/doc-2.md",
        title: "Doc 2",
        snippet: "shared",
        score: 0.9,
        source: { relPath: "doc-2.md", mime: "text/markdown", ext: ".md" },
        conversion: { mirrorHash: "shared-hash" },
      },
    ];
    const lineage = await attachSearchResultEgressLineage(
      store,
      searchResults,
      {
        ownershipHashes: ["shared-hash"],
      }
    );
    expect(lineage.ok).toBe(true);
  });
});

describe("Round 1 Codex regression guards (F1–F9)", () => {
  test("F1: lexical-only hybrid graph expansion adds graph input once (no doubled RRF weight)", async () => {
    const docs = [makeDoc(1), makeDoc(2)];
    const chunks = new Map<string, ChunkRow[]>([
      ["hash-1", [makeChunk(0, "seed document content", "hash-1")]],
      ["hash-2", [makeChunk(0, "linked graph neighbor", "hash-2")]],
    ]);
    const store = {
      searchFts: async () => ok([makeFts(1, -2.0)]),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getDocumentsByMirrorHashes: async (hashes: string[]) =>
        ok(docs.filter((d) => hashes.includes(d.mirrorHash!))),
      getDocumentsByDocids: async (docids: string[]) =>
        ok(docs.filter((d) => docids.includes(d.docid))),
      getChunksBatch: async () => ok(chunks),
      getChunksBySequenceBatch: async (
        keys: Array<{ mirrorHash: string; seq: number }>
      ) =>
        ok(
          new Map(
            keys.map((k) => [k.mirrorHash, chunks.get(k.mirrorHash) ?? []])
          )
        ),
      getTagsBatch: async () => ok(new Map()),
      getGraphNeighborsForSeeds: async () =>
        ok({
          links: [
            {
              source: "#doc1",
              target: "#doc2",
              type: "wiki" as const,
              weight: 1,
            },
          ],
          meta: { seedDocumentIds: [1], examinedLinkRows: 1, returnedEdges: 1 },
        }),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        rerankPort: null,
      },
      "seed document",
      { explain: true, noExpand: true, graph: true }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const neighborExplain = result.value.meta.explain?.results.find(
      (r) => r.docid === "#doc2"
    );
    expect(neighborExplain).toBeDefined();
    // Single rank-1 graph contribution: weight 0.8 / (60 + 1) ≈ 0.01311475 (NOT doubled 0.0262295).
    expect(neighborExplain!.fusionScore).toBeCloseTo(0.8 / 61, 6);
  });

  test("F2: missing vec_v1_<partition> mirror falls back seamlessly to authoritative vector_variants scan", async () => {
    const dir = await makeTempDir("gno-missing-mirror-");
    const dbPath = join(dir, "index.sqlite");
    const adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
    let db: Database | undefined;
    try {
      await adapter.syncCollections([
        {
          name: "alpha",
          path: join(dir, "alpha"),
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ]);
      await adapter.upsertDocument({
        collection: "alpha",
        relPath: "only.md",
        sourceHash: "src-only",
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 10,
        sourceMtime: NOW,
        title: "only.md",
        mirrorHash: "mh-only",
      });
      await adapter.upsertContent("mh-only", "only body");
      await adapter.upsertChunks("mh-only", [
        { seq: 0, pos: 0, text: "only body", startLine: 1, endLine: 1 },
      ]);
      const identity = {
        model: "missing-mirror-model",
        modelFingerprint: "fp-mm",
        contextSize: 512,
        truncationPolicy: "tail-v1",
        dimensions: 4,
      };
      db = new Database(dbPath);
      expect(
        (
          await createVectorIndexPort(db, {
            model: identity.model,
            dimensions: 4,
          })
        ).ok
      ).toBe(true);
      const vstore = await createVectorVariantStore(db, identity);
      const pending = vstore.pending({ limit: 10 });
      vstore.write(
        pending.map((owner) => ({
          owner,
          embedding: new Float32Array([1, 0, 0, 0]),
        }))
      );
      vstore.activate(vstore.epoch());

      const q = new Float32Array([1, 0, 0, 0]);
      // Missing vec0 mirror table falls back seamlessly to authoritative vector_variants.
      db.run(`DROP TABLE vec_v1_${vstore.partitionId}`);
      const single = searchVectorVariants(db, identity.model, 4, q, 5, {
        partitionId: vstore.partitionId,
      });
      const batch = searchVectorVariantsBatch(db, identity.model, 4, [q], [5], {
        partitionId: vstore.partitionId,
      });
      expect(single?.map((r) => r.mirrorHash)).toEqual(["mh-only"]);
      expect(batch?.[0]?.map((r) => r.mirrorHash)).toEqual(["mh-only"]);
    } finally {
      db?.close();
      await adapter.close();
    }
  });

  test("F3: searchNearestBatch failure retries unique embeddings individually and retains healthy vector legs", async () => {
    const searchNearestBatch = mock(
      async (): Promise<StoreResult<VectorSearchResult[][]>> =>
        err("VEC_SEARCH_FAILED", "bad variant dimension")
    );
    const searchNearest = mock(
      async (emb: Float32Array): Promise<StoreResult<VectorSearchResult[]>> =>
        emb[1]! > 0.5
          ? err("VEC_SEARCH_FAILED", "bad variant")
          : ok([{ mirrorHash: "hash-1", seq: 0, distance: 0.05 }])
    );
    const embedPort = {
      modelUri:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
      init: async () => ok(undefined),
      dimensions: () => 3,
      dispose: async () => undefined,
      embed: async () => ok([1, 0, 0]),
      embedBatch: async (texts: string[]) => ok(texts.map((_, i) => [1, i, 0])),
    } as unknown as EmbeddingPort;
    const vectorIndex: VectorIndexPort = {
      searchAvailable: true,
      model: embedPort.modelUri,
      dimensions: 3,
      vecDirty: false,
      upsertVectors: async () => ok(undefined),
      deleteVectorsForMirror: async () => ok(undefined),
      rebuildVecIndex: async () => ok(undefined),
      syncVecIndex: async () => ok({ added: 0, removed: 0 }),
      searchNearest,
      searchNearestBatch,
    };
    const store = {
      searchFts: async () => ok([]),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getDocumentsByMirrorHashes: async () => ok([makeDoc(1)]),
      getChunksBatch: async () =>
        ok(new Map([["hash-1", [makeChunk(0, "healthy leg", "hash-1")]]])),
      getChunksBySequenceBatch: async () =>
        ok(new Map([["hash-1", [makeChunk(0, "healthy leg", "hash-1")]]])),
      getTagsBatch: async () => ok(new Map()),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "original query",
      { queryModes: [{ mode: "intent", text: "failing variant" }] }
    );
    expect(result.ok).toBe(true);
    expect(searchNearestBatch).toHaveBeenCalledTimes(1);
    expect(searchNearest).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.value.meta.vectorsUsed).toBe(true);
      expect(result.value.results.map((r) => r.docid)).toEqual(["#doc1"]);
    }
  });

  test("F6: partial content read failure preserves healthy sources in generateGroundedAnswer", async () => {
    const goodBody = "Healthy canonical answer evidence line.";
    const goodHash = new Bun.CryptoHasher("sha256")
      .update(goodBody)
      .digest("hex");
    const store = {
      getContent: async (hash: string) =>
        hash === goodHash
          ? ok(goodBody)
          : err("QUERY_FAILED", "simulated single-doc failure"),
    } as unknown as StorePort;
    const generate = mock(async () => ok("Supported [1]."));
    const genPort = {
      modelUri: "hf:test/gen.gguf",
      generate,
      dispose: async () => undefined,
    } as unknown as GenerationPort;

    const answer = await generateGroundedAnswer(
      { genPort, store },
      "What is the evidence?",
      [
        {
          docid: "#bad",
          uri: "gno://notes/bad.md",
          title: "Bad",
          snippet: "...display snippet...",
          score: 0.95,
          source: {
            relPath: "bad.md",
            mime: "text/markdown",
            ext: ".md",
            sourceHash: "bad-source-hash",
          },
          conversion: { mirrorHash: "bad-hash" },
        },
        {
          docid: "#good",
          uri: "gno://notes/good.md",
          title: "Good",
          snippet: "...display snippet...",
          score: 0.9,
          source: {
            relPath: "good.md",
            mime: "text/markdown",
            ext: ".md",
            sourceHash: goodHash,
          },
          conversion: { mirrorHash: goodHash },
        },
      ],
      256
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(answer).not.toBeNull();
    expect(answer?.citations.map((c) => c.docid)).toEqual(["#good"]);
  });

  test("F7: malformed citation marker crossing a claim boundary does not swallow the next claim's valid citation", async () => {
    const fixture = verifierFixture(false);
    const harness = createVerifierStore(fixture.state);
    const capsule = await capsuleFor(harness.store, fixture.state);
    const receipt = await verifyContextCapsule(
      capsule,
      verifierDeps(harness.store, capsule)
    );
    const ev = capsule.evidence[0]!;

    // Case A: orphan malformed marker crossing into the first substantive claim.
    const orphanCrossing = verifyClaimsDeterministically({
      capsule,
      answer: `[evidence:bad. Mina owns this [evidence:${ev.evidenceId}].`,
      freshness: receipt,
    });
    expect(orphanCrossing.claims).toHaveLength(1);
    expect(orphanCrossing.claims[0]?.evidence.map((e) => e.evidenceId)).toEqual(
      [ev.evidenceId]
    );

    // Case B: in-claim malformed marker crossing into the second substantive claim.
    const claimCrossing = verifyClaimsDeterministically({
      capsule,
      answer: `Alpha claim [evidence:bad. Mina owns this [evidence:${ev.evidenceId}].`,
      freshness: receipt,
    });
    expect(claimCrossing.claims).toHaveLength(2);
    expect(claimCrossing.claims[0]?.rejectedCitations[0]?.reason).toBe(
      "malformed_citation"
    );
    expect(claimCrossing.claims[1]?.evidence.map((e) => e.evidenceId)).toEqual([
      ev.evidenceId,
    ]);
  });

  test("F8: BM25 --full restores original chunk startLine when full content replaces frontmatter-stripped snippet", async () => {
    const rawWithFrontmatter = "---\ntitle: Demo\ntags: [a]\n---\nBody line.";
    const store = {
      searchFts: async () => ok([makeFts(1, -2.0, 0)]),
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getChunksBySequenceBatch: async () =>
        ok(
          new Map([
            [
              "hash-1",
              [
                makeChunk(0, rawWithFrontmatter, "hash-1", {
                  startLine: 1,
                  endLine: 5,
                }),
              ],
            ],
          ])
        ),
      getChunksBatch: async () => ok(new Map()),
      getContentBatch: async () =>
        ok(new Map([["hash-1", rawWithFrontmatter]])),
    } as unknown as StorePort;

    const result = await searchBm25(store, "Body", { full: true, limit: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results[0]?.snippet).toBe(rawWithFrontmatter);
      expect(result.value.results[0]?.snippetRange).toBeUndefined();
      expect(result.value.results[0]?.line).toBe(1);
    }
  });

  test("F9: failed original FTS query is not repeated when lexical expansion variant matches query.trim()", async () => {
    const ftsQueries: string[] = [];
    const searchFts = mock(async (q: string) => {
      ftsQueries.push(q);
      return err("QUERY_FAILED", "transient fts failure");
    });
    const expandPort = {
      modelUri: "hf:test/expand.gguf",
      generate: async () =>
        ok(
          JSON.stringify({
            lexicalQueries: ["same query", "same query variant"],
            vectorQueries: [],
          })
        ),
      dispose: async () => undefined,
    } as unknown as GenerationPort;
    const store = {
      searchFts,
      getCollections: async () =>
        ok([
          {
            name: "notes",
            path: "/notes",
            egressPolicy: "local_only",
            egressPolicySource: "legacy_default",
          },
        ]),
      getDocumentsByMirrorHashes: async () => ok([]),
      getChunksBatch: async () => ok(new Map()),
      getTagsBatch: async () => ok(new Map()),
    } as unknown as StorePort;

    const result = await searchHybrid(
      {
        store,
        config: TEST_CONFIG,
        vectorIndex: null,
        embedPort: null,
        expandPort,
        rerankPort: null,
      },
      "  same query  ",
      { limit: 5 }
    );
    expect(result.ok).toBe(true);
    // Original query ran once and failed; identical trimmed variant reused that failure.
    expect(ftsQueries).toEqual(["  same query  ", "same query variant"]);
  });

  test("Round 2: lazyGenerationPort propagates underlying modelPath/modelFingerprint so server expansion hits llm_cache on repeat queries", async () => {
    const dir = await makeTempDir("gno-lazy-exp-");
    const modelPath = join(dir, "lazy-expand.gguf");
    await writeFile(modelPath, "lazy-gguf-v1");
    const stat = statSync(modelPath);
    const modelFingerprint = `file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    const cache = new Map<string, string>();
    const generate = mock(async () => ({
      ok: true as const,
      value: JSON.stringify({
        lexicalQueries: ["lazy cache query", "lazy cache hit"],
        vectorQueries: ["lazy cache expansion"],
      }),
    }));
    const lazyPort = lazyGenerationPort(
      "hf:test/lazy-expand.gguf",
      async () => ({
        ok: true as const,
        value: {
          modelUri: "hf:test/lazy-expand.gguf",
          modelPath,
          modelFingerprint,
          structuredOutput: "json_schema" as const,
          generate,
          dispose: async () => undefined,
        },
      })
    );
    let lookups = 0;
    let hits = 0;
    const deps = {
      genPort: lazyPort,
      getCache: async (k: string) => cache.get(k) ?? null,
      setCache: async (k: string, v: string) => {
        cache.set(k, v);
      },
      onCacheLookup: () => {
        lookups += 1;
      },
      onCacheHit: () => {
        hits += 1;
      },
    };

    // Cold first call initializes lazyPort, generates once, and populates cache via captured modelFingerprint.
    const first = await expandQueryCached(deps, "lazy cache query", {
      lang: "en",
      contextSize: 2048,
    });
    expect(first.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect(lazyPort.modelPath).toBe(modelPath);
    expect(lazyPort.modelFingerprint).toBe(modelFingerprint);

    // Repeat call reads modelFingerprint + verifies on-disk file and hits cache with zero extra generations.
    const second = await expandQueryCached(deps, "lazy cache query", {
      lang: "en",
      contextSize: 2048,
    });
    expect(second.ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(lookups).toBe(1);
    expect(hits).toBe(1);

    // Round 3: Replacing the GGUF mid-flight during a cold lazy generation must NOT
    // cache model A's expansion under model B's fingerprint.
    const racePath = join(dir, "race-expand.gguf");
    await writeFile(racePath, "model-A-weights");
    const statA = statSync(racePath);
    const fpA = `file:${statA.size}:${Math.trunc(statA.mtimeMs)}`;
    const raceCache = new Map<string, string>();
    const genA = mock(async () => {
      // Simulate replacing the GGUF on disk while model A is mid-generation.
      await writeFile(racePath, "model-B-replaced-longer-weights");
      return {
        ok: true as const,
        value: JSON.stringify({
          lexicalQueries: ["race query", "race query model A"],
          vectorQueries: ["race query model A semantic"],
        }),
      };
    });
    const lazyPortA = lazyGenerationPort(
      "hf:test/race-expand.gguf",
      async () => ({
        ok: true as const,
        value: {
          modelUri: "hf:test/race-expand.gguf",
          modelPath: racePath,
          modelFingerprint: fpA,
          structuredOutput: "json_schema" as const,
          generate: genA,
          dispose: async () => undefined,
        },
      })
    );
    await expandQueryCached(
      {
        genPort: lazyPortA,
        getCache: async (k) => raceCache.get(k) ?? null,
        setCache: async (k, v) => {
          raceCache.set(k, v);
        },
      },
      "race query",
      { lang: "en", contextSize: 2048 }
    );
    // Mid-flight file replacement aborted the cache write.
    expect(raceCache.size).toBe(0);

    // A fresh port for model B must invoke model B (never receive model A's variants).
    const statB = statSync(racePath);
    const fpB = `file:${statB.size}:${Math.trunc(statB.mtimeMs)}`;
    const genB = mock(async () => ({
      ok: true as const,
      value: JSON.stringify({
        lexicalQueries: ["race query", "race query model B"],
        vectorQueries: ["race query model B semantic"],
      }),
    }));
    const portB = {
      modelUri: "hf:test/race-expand.gguf",
      modelPath: racePath,
      modelFingerprint: fpB,
      structuredOutput: "json_schema" as const,
      generate: genB,
      dispose: async () => undefined,
    };
    const resB = await expandQueryCached(
      {
        genPort: portB,
        getCache: async (k) => raceCache.get(k) ?? null,
        setCache: async (k, v) => {
          raceCache.set(k, v);
        },
      },
      "race query",
      { lang: "en", contextSize: 2048 }
    );
    expect(resB.ok).toBe(true);
    expect(genB).toHaveBeenCalledTimes(1);
    if (resB.ok) {
      expect(resB.value?.vectorQueries).toEqual([
        "race query model B semantic",
      ]);
    }
  });
});
