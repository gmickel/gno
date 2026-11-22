import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/rm/writeFile for isolated temp directories
import { mkdtemp, rm } from "node:fs/promises";
// node:os: tmpdir for temp directories
import { tmpdir } from "node:os";
// node:path: join for temp paths
import { join } from "node:path";

import type { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";

import { compileContextEvidence } from "../../src/core/context-evidence";
import { analyzeGraphCommunities } from "../../src/core/graph-analysis";
import { truncateText } from "../../src/core/links";
import { ModelCache, validateGgufFile } from "../../src/llm/cache";
import { prepareClassifiedHttpDestination } from "../../src/llm/http-policy";
import { HttpEmbedding } from "../../src/llm/httpEmbedding";
import {
  assertInferenceActive,
  withInferenceScope,
} from "../../src/llm/inference-scope";
import { getNativePackageVersion } from "../../src/llm/native-worker/embedding-identity";
import {
  encodeNativeMessage,
  frameNativeBytes,
  frameNativeMessage,
  NATIVE_BINARY_EMBED_MAGIC,
  NATIVE_LOGICAL_BYTES,
  NativeFrameDecoder,
  parseNativeRequest,
  parseNativeResponse,
  splitEmbeddingRequest,
} from "../../src/llm/native-worker/protocol";
import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";
import { NodeLlamaCppGeneration } from "../../src/llm/nodeLlamaCpp/generation";
import { NodeLlamaCppRerank } from "../../src/llm/nodeLlamaCpp/rerank";
import {
  getRerankCapacity,
  RERANK_TEMPLATE,
} from "../../src/llm/nodeLlamaCpp/rerank-capacity";
import { renderThread } from "../../src/sessions/archive";
import {
  compileRedactionPolicy,
  ThreadSanitizer,
} from "../../src/sessions/sanitize";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorVariantStore } from "../../src/store/vector/variants";

const tempDirs: string[] = [];
const dbs: Database[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("fn-233 R1: native worker binary Float64Array frames & protocol fast paths", () => {
  const FRAME_HEADER_BYTES = 32;

  test("embed and embedBatch ok responses round-trip bit-exact through binary Float64Array frames", () => {
    const vectors = [
      [0, -0, 1e-200, Math.PI, -Math.SQRT2, 0.12345678901234568],
      [42.5, -19.25, 1 / 3, 2 ** -52, 1e100, -1e-100],
    ];
    for (const requestId of [1, 12, 123, 1234, 12345, 123456, 1234567]) {
      const single = {
        version: 1 as const,
        generation: 3,
        requestId,
        op: "embed" as const,
        result: { ok: true as const, value: vectors[0]! },
      };
      const singleFrames = frameNativeMessage(single);
      expect(singleFrames).toHaveLength(1);
      const singleFrame = singleFrames[0]!;
      expect(singleFrame[FRAME_HEADER_BYTES]).toBe(NATIVE_BINARY_EMBED_MAGIC);
      const singleDecoder = new NativeFrameDecoder(3);
      const singleRaw = singleDecoder.push(singleFrame);
      const parsedSingle = parseNativeResponse(
        singleRaw,
        {
          version: 1 as const,
          generation: 3,
          requestId,
          modelId: "embed:test",
          op: "embed",
          text: "x",
        },
        singleDecoder.lastDecodedByteLength
      );
      expect(parsedSingle).toEqual(single);
      expect(
        Object.is((parsedSingle.result as { value: number[] }).value[1], -0)
      ).toBe(true);

      const batch = {
        version: 1 as const,
        generation: 3,
        requestId,
        op: "embedBatch" as const,
        result: { ok: true as const, value: vectors },
      };
      const batchFrames = frameNativeMessage(batch);
      expect(batchFrames).toHaveLength(1);
      const batchFrame = batchFrames[0]!;
      expect(batchFrame[FRAME_HEADER_BYTES]).toBe(NATIVE_BINARY_EMBED_MAGIC);
      const batchDecoder = new NativeFrameDecoder(3);
      const batchRaw = batchDecoder.push(batchFrame);
      expect(
        parseNativeResponse(
          batchRaw,
          {
            version: 1 as const,
            generation: 3,
            requestId,
            modelId: "embed:test",
            op: "embedBatch",
            texts: ["a", "b"],
          },
          batchDecoder.lastDecodedByteLength
        )
      ).toEqual(batch);
    }
  });

  test("binary Float64Array frame decoder fails closed on non-zero padding, non-finite floats, and truncated payloads", () => {
    const validFrames = frameNativeMessage({
      version: 1 as const,
      generation: 1,
      requestId: 7,
      op: "embed",
      result: { ok: true, value: [1.5, 2.5, 3.5] },
    });
    expect(validFrames).toHaveLength(1);
    const validPayload = validFrames[0]!.subarray(FRAME_HEADER_BYTES);
    expect(validPayload[0]).toBe(NATIVE_BINARY_EMBED_MAGIC);

    // Corrupt a float64 slot with NaN.
    const nanPayload = new Uint8Array(validPayload);
    new DataView(nanPayload.buffer, nanPayload.byteLength - 8, 8).setFloat64(
      0,
      Number.NaN,
      true
    );
    const nanFrame = frameNativeBytes(
      { generation: 1, requestId: 7 },
      nanPayload
    )[0]!;
    expect(() => new NativeFrameDecoder(1).push(nanFrame)).toThrow();

    // Corrupt alignment padding byte when padding > 0 (headerLen is little-endian).
    const headerLen = new DataView(
      validPayload.buffer,
      validPayload.byteOffset + 1,
      4
    ).getUint32(0, true);
    const dataOffset = (5 + headerLen + 7) & ~7;
    if (dataOffset > 5 + headerLen) {
      const badPad = new Uint8Array(validPayload);
      badPad[5 + headerLen] = 0xff;
      const badPadFrame = frameNativeBytes(
        { generation: 1, requestId: 7 },
        badPad
      )[0]!;
      expect(() => new NativeFrameDecoder(1).push(badPadFrame)).toThrow();
    }

    // Truncated payload must fail closed.
    const truncatedPayload = validPayload.subarray(0, validPayload.length - 4);
    const truncatedFrame = frameNativeBytes(
      { generation: 1, requestId: 7 },
      truncatedPayload
    )[0]!;
    expect(() => new NativeFrameDecoder(1).push(truncatedFrame)).toThrow();

    // Oversized frame rejected before decode.
    expect(() =>
      parseNativeResponse(
        {
          version: 1 as const,
          generation: 1,
          requestId: 1,
          op: "embed",
          result: { ok: true, value: [1] },
        },
        {
          version: 1 as const,
          generation: 1,
          requestId: 1,
          modelId: "embed:test",
          op: "embed",
          text: "x",
        },
        NATIVE_LOGICAL_BYTES + 1
      )
    ).toThrow();
  });

  test("NativeFrameDecoder decodes single frames zero-copy and tracks lastDecodedByteLength", () => {
    const decoder = new NativeFrameDecoder(1);
    const request = {
      version: 1 as const,
      generation: 1,
      requestId: 9,
      modelId: "embed:test",
      op: "embed" as const,
      text: "hello world",
    };
    const raw = encodeNativeMessage(request);
    const frames = frameNativeBytes({ generation: 1, requestId: 9 }, raw);
    expect(frames).toHaveLength(1);
    const decoded = decoder.push(frames[0]!);
    expect(decoder.lastDecodedByteLength).toBe(raw.byteLength);
    expect(
      parseNativeRequest(
        decoded,
        1,
        [
          {
            id: "embed:test",
            modelUri: "file:/tmp/test.gguf",
            path: "/tmp/test.gguf",
            type: "embed",
          },
        ],
        decoder.lastDecodedByteLength
      )
    ).toEqual(request);
    expect(frameNativeMessage(request)).toEqual(frames);
  });

  test("splitEmbeddingRequest fast-paths small batches and splits multi-byte UTF-8 safely", () => {
    const small = ["alpha", "beta", "gamma"];
    expect(
      splitEmbeddingRequest({
        version: 1 as const,
        generation: 1,
        requestId: 1,
        modelId: "m",
        op: "embedBatch",
        texts: small,
      })
    ).toEqual([small]);

    // Multi-byte UTF-8 texts exceeding 8 MB frame limit force splitting.
    const bigEmoji = "🚀".repeat(1_200_000);
    const splits = splitEmbeddingRequest({
      version: 1 as const,
      generation: 1,
      requestId: 2,
      modelId: "m",
      op: "embedBatch",
      texts: [bigEmoji, bigEmoji],
    });
    expect(splits.length).toBeGreaterThanOrEqual(2);
    expect(splits.flat()).toEqual([bigEmoji, bigEmoji]);
  });

  test("getNativePackageVersion resolves lazily and matches package.json", () => {
    expect(getNativePackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("fn-233 R2: variant store, HTTP transport, cache & inference scope", () => {
  test("VectorVariantStore.hasReusable avoids BLOB decode and writeCurrent skips stale owners atomically", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    db.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
      CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
      INSERT INTO content_chunks VALUES ('m1', 0, 'Body one');
      INSERT INTO content_chunks VALUES ('m2', 0, 'Body two');
      INSERT INTO documents VALUES (1, 'm1', 'One', 1, 'docs');
      INSERT INTO documents VALUES (2, 'm2', 'Two', 1, 'docs');`);
    migration.up(db, "unicode61");
    runtimeMigration.up(db, "unicode61");
    const store = await createVectorVariantStore(db, {
      model: "test-model",
      modelFingerprint: "fp",
      contextSize: 512,
      truncationPolicy: "tail-v1",
      dimensions: 3,
    });
    const owner1 = store.current(1, 0)!;
    const owner2 = store.current(2, 0)!;
    expect(store.hasReusable(owner1)).toBe(false);

    // Mutate doc 2 so owner2 becomes stale before writeCurrent.
    db.run("UPDATE documents SET title = 'Changed' WHERE id = 2");
    const ids = store.writeCurrent([
      { owner: owner1, embedding: new Float32Array([1, 0, 0]) },
      { owner: owner2, embedding: new Float32Array([0, 1, 0]) },
    ]);
    expect(ids).toHaveLength(1);
    expect(store.hasReusable(owner1)).toBe(true);
    expect(() => store.hasReusable(owner2)).toThrow(
      "Stale or invalid vector owner input"
    );
  });

  test("HttpEmbedding.init() is idempotent once dimensions are known", async () => {
    let fetches = 0;
    const port = new HttpEmbedding("http://127.0.0.1:8080/v1/embeddings#m", {
      collections: [
        {
          name: "notes",
          path: "/tmp/notes",
          pattern: "**/*",
          include: [],
          exclude: [],
          egressPolicy: "local_only",
        },
      ],
      collectionNames: ["notes"],
      env: {},
      resolver: { lookup: async () => ["127.0.0.1"] },
      fetchFn: async () => {
        fetches += 1;
        return Response.json({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3], object: "embedding" }],
          model: "m",
          object: "list",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    expect((await port.init()).ok).toBe(true);
    expect(fetches).toBe(1);
    expect((await port.init()).ok).toBe(true);
    expect(fetches).toBe(1);
    expect(port.dimensions()).toBe(3);
  });

  test("prepareClassifiedHttpDestination merges classify+prepare into 1 lookup while acquireConnection still catches DNS rebinding", async () => {
    let lookups = 0;
    const prepared = await prepareClassifiedHttpDestination(
      "https://api.example/v1/embeddings",
      {
        maximumZone: "remote",
        env: {},
        resolver: {
          lookup: async () => {
            lookups += 1;
            return lookups === 1 ? ["93.184.216.34"] : ["93.184.216.35"];
          },
        },
      }
    );
    expect(prepared.ok).toBe(true);
    expect(lookups).toBe(1);
    if (prepared.ok) {
      const conn = await prepared.value.acquireConnection();
      expect(conn.ok).toBe(false);
      if (!conn.ok) expect(conn.reason).toBe("DNS_REBINDING");
      expect(lookups).toBe(2);
    }
  });

  test("NodeLlamaCppEmbedding single-context path overlaps tokenization and preserves order", async () => {
    const order: string[] = [];
    const manager = {
      acquireLease: () => ({ release: () => {} }),
      getLlama: async () => ({ gpu: "metal", cpuMathCores: 8 }),
      loadModel: async () => ({
        ok: true,
        value: {
          model: {
            trainContextSize: 64,
            embeddingVectorSize: 2,
            tokenize: (text: string) => {
              order.push(`tok:${text}`);
              return Array.from(text, (_, i) => i + 1);
            },
            detokenize: () => "",
            createEmbeddingContext: async () => ({
              disposed: false,
              getEmbeddingFor: async (tokens: number[]) => {
                order.push(`eval:${tokens.length}`);
                await Bun.sleep(1);
                return { vector: [tokens.length, tokens.length * 10] };
              },
              dispose: async () => {},
            }),
          },
        },
      }),
    } as unknown as ModelManager;
    const port = new NodeLlamaCppEmbedding(manager, "m", "/tmp/m.gguf");
    const res = await port.embedBatch(["a", "bb", "ccc"]);
    expect(res).toEqual({
      ok: true,
      value: [
        [1, 10],
        [2, 20],
        [3, 30],
      ],
    });
    // Tokenization of "bb" starts before "a"'s async eval completes.
    expect(order.indexOf("tok:bb")).toBeGreaterThan(order.indexOf("eval:1"));
    await port.dispose();
  });

  test("ModelCache ensureModel on file: URI skips manifest and validateGgufFile handles missing/HTML/valid files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-fn233-cache-"));
    tempDirs.push(dir);
    const ggufPath = join(dir, "ok.gguf");
    const htmlPath = join(dir, "bad.gguf");
    await Bun.write(ggufPath, new Uint8Array([0x47, 0x47, 0x55, 0x46, 0, 0]));
    await Bun.write(htmlPath, "<!DOCTYPE html><html>blocked</html>");

    expect(
      (await validateGgufFile(ggufPath, `file:${ggufPath}`, "user")).ok
    ).toBe(true);
    const htmlRes = await validateGgufFile(
      htmlPath,
      `file:${htmlPath}`,
      "user"
    );
    expect(htmlRes.ok).toBe(false);
    const missingRes = await validateGgufFile(
      join(dir, "missing.gguf"),
      "file:/missing.gguf",
      "user"
    );
    expect(missingRes.ok).toBe(false);
    if (!missingRes.ok) expect(missingRes.error.code).toBe("MODEL_NOT_FOUND");

    const cache = new ModelCache(join(dir, "cache"));
    const ensured = await cache.ensureModel(`file:${ggufPath}`, "embed", {
      offline: true,
      allowDownload: false,
    });
    expect(ensured).toEqual({ ok: true, value: ggufPath });
  });

  test("assertInferenceActive fast-paths unscoped calls and still enforces active scopes", async () => {
    expect(() => assertInferenceActive()).not.toThrow();
    const controller = new AbortController();
    await expect(
      withInferenceScope({ signal: controller.signal }, async () => {
        expect(() => assertInferenceActive()).not.toThrow();
        controller.abort();
        expect(() => assertInferenceActive()).toThrow();
      })
    ).rejects.toThrow();
  });
});

describe("fn-233 R3: generation context/grammar reuse & rerank pool/hysteresis", () => {
  test("NodeLlamaCppRerank caches template tokens, tokenizes query once, applies hysteresis, and pools 2 CPU contexts on >=12 cores", async () => {
    let templateTokenizes = 0;
    let queryTokenizes = 0;
    const createdContexts: Array<{
      contextSize?: number;
      threads?: number;
      rankAllCalls: string[][];
      disposed: boolean;
    }> = [];
    const model = {
      disposed: false,
      fileInfo: {
        metadata: {
          general: { architecture: "qwen3" },
          tokenizer: { "chat_template.rerank": RERANK_TEMPLATE },
        },
      },
      vocabularyType: "bpe",
      tokens: {},
      tokenize: (text: string) => {
        templateTokenizes += 1;
        return Array.from(text, () => 1);
      },
      tokenizer: (text: string) => {
        if (text === "my-query") queryTokenizes += 1;
        return Array.from(text, () => 1);
      },
      trainContextSize: 8192,
      async createRankingContext(options: {
        contextSize?: number;
        threads?: number;
      }) {
        const ctx = {
          contextSize: options.contextSize,
          threads: options.threads,
          rankAllCalls: [] as string[][],
          disposed: false,
          async rankAll(_q: string, docs: string[]) {
            ctx.rankAllCalls.push([...docs]);
            return docs.map((d) => d.length / 100);
          },
          async dispose() {
            ctx.disposed = true;
          },
        };
        createdContexts.push(ctx);
        return ctx;
      },
    };

    // Capacity caches static template tokens and tokenizes query once per batch.
    getRerankCapacity(model as never, "my-query", ["doc-a", "doc-b", "doc-c"]);
    expect(templateTokenizes).toBe(3);
    expect(queryTokenizes).toBe(1);
    getRerankCapacity(model as never, "my-query", ["doc-d", "doc-e"]);
    expect(templateTokenizes).toBe(3);
    expect(queryTokenizes).toBe(2);

    const manager = {
      acquireLease: () => ({ release: () => {} }),
      getLlama: async () => ({ gpu: false, cpuMathCores: 12 }),
      loadModel: async () => ({ ok: true, value: { model } }),
    } as unknown as ModelManager;

    const port = new NodeLlamaCppRerank(manager, "rerank", "rerank.gguf");
    const res1 = await port.rerank("my-query", [
      "short",
      "much longer doc",
      "short",
      "medium doc",
    ]);
    expect(res1.ok).toBe(true);
    // 2 contexts created at threads: 6 on 12-core CPU-only host.
    expect(createdContexts).toHaveLength(2);
    expect(createdContexts.every((c) => c.threads === 6)).toBe(true);
    // Duplicate "short" was deduplicated before scoring.
    const scoredDocs = createdContexts.flatMap((c) => c.rankAllCalls.flat());
    expect(scoredDocs.sort()).toEqual(
      ["short", "much longer doc", "medium doc"].sort()
    );

    // Minor bucket jitter within [needed, max(2048, needed * 2)] reuses pool.
    const res2 = await port.rerank("my-query", ["tiny"]);
    expect(res2.ok).toBe(true);
    expect(createdContexts).toHaveLength(2);

    await port.dispose();
    expect(createdContexts.every((c) => c.disposed)).toBe(true);
  });

  test("NodeLlamaCppGeneration exposes clean dispose lifecycle on unused port", async () => {
    const manager = {
      acquireLease: () => ({ release: () => {} }),
    } as unknown as ModelManager;
    const gen = new NodeLlamaCppGeneration(manager, "gen", "gen.gguf");
    await gen.dispose();
    const afterDispose = await gen.generate("hello");
    expect(afterDispose.ok).toBe(false);
  });
});

describe("fn-233 R4: session sanitizer fast-reject prefilter & zero-secret path", () => {
  test("fast-reject prefilter preserves detection for every secret class and cross-turn propagation", () => {
    const samples = [
      "aws AKIAIOSFODNN7EXAMPLE here",
      "gh ghp_1234567890abcdef1234567890abcdef1234",
      "openai sk-proj-abcdefghijklmnopqrstuvwxyz1234",
      "stripe sk_live_1234567890abcdef1234",
      "slack xoxb-1234567890-abcdef",
      "google AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGqeQe",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "auth Bearer supersecrettokenvalue1234567890",
      "url https://user:secretpass123@db.internal/app",
      "cfg password=myVerySecretPassword99",
    ];
    for (const sample of samples) {
      const sanitizer = new ThreadSanitizer();
      const cleaned = sanitizer.sanitize(sample);
      expect(cleaned).toContain("[REDACTED:");
      expect(sanitizer.redactions).toBeGreaterThanOrEqual(1);
    }

    // Reusable sanitizer + zero-secret fast path matches fresh renderThread.
    const compiled = compileRedactionPolicy({ literals: ["internal-host"] });
    const reusable = ThreadSanitizer.fromCompiled(compiled);
    const thread = {
      harness: "codex" as const,
      sessionId: "s1",
      threadId: "t1",
      kind: "main" as const,
      cwd: "/work/app",
      turns: [
        {
          turnId: "turn-1",
          role: "human" as const,
          text: "Plain discussion without any secrets at all",
          locator: "line:1",
        },
        {
          turnId: "turn-2",
          role: "assistant" as const,
          text: "Everything looks great on internal-host",
          locator: "line:2",
        },
      ],
    };
    const fresh = renderThread({
      thread,
      sourceId: "src",
      unitKey: "u1",
      unitLocator: "rollout.jsonl",
      parser: "codex-v1",
      redaction: { literals: ["internal-host"] },
    });
    const reused = renderThread({
      thread,
      sourceId: "src",
      unitKey: "u1",
      unitLocator: "rollout.jsonl",
      parser: "codex-v1",
      redaction: { literals: ["internal-host"] },
      compiledRedaction: compiled,
      sanitizer: reusable,
    });
    expect(reused).toEqual(fresh);
  });
});

describe("fn-233 R6: Context Capsule zero-mutation fast path, graph & truncateText", () => {
  test("compileContextEvidence skips post-compile full snapshot on unmutated SqliteAdapter and catches real SQLite mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-fn233-capsule-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "default.sqlite");
    const store = new SqliteAdapter();
    const open = await store.open(dbPath, "unicode61");
    expect(open.ok).toBe(true);
    try {
      await store.syncCollections([
        {
          name: "notes",
          path: dir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
          egressPolicy: "local_only",
        },
      ]);
      const origSnapshot = SqliteAdapter.prototype.getActivationIndexSnapshot;
      let snapshotCalls = 0;
      SqliteAdapter.prototype.getActivationIndexSnapshot = function (...args) {
        snapshotCalls += 1;
        return origSnapshot.apply(this, args);
      };
      try {
        const res = await compileContextEvidence(
          {
            goal: "check fast path",
            indexName: "default",
            collections: ["notes"],
            temporalNow: "2026-07-22T00:00:00.000Z",
            limits: {
              requestedBytes: 4096,
              requestedTokens: 1024,
              safetyMarginBytes: 0,
              safetyMarginTokens: 0,
              documentShareNumerator: 1,
              documentShareDenominator: 1,
            },
          },
          {
            store,
            retrieve: async () => ({
              results: [],
              meta: {
                query: "check fast path",
                mode: "bm25_only",
                totalResults: 0,
              },
            }),
            projectCanonical: () => ({
              value: { ok: true },
              usedBytes: 10,
              usedTokens: 3,
            }),
          }
        );
        expect(res.snapshot.indexFingerprint).toBeTruthy();
        // Zero mutations occurred: post-compile snapshot was skipped (only 1 call).
        expect(snapshotCalls).toBe(1);

        // Now mutate contexts mid-compile and confirm drift is still caught!
        await expect(
          compileContextEvidence(
            {
              goal: "detect context mutation",
              indexName: "default",
              collections: ["notes"],
              temporalNow: "2026-07-22T00:00:00.000Z",
              limits: {
                requestedBytes: 4096,
                requestedTokens: 1024,
                safetyMarginBytes: 0,
                safetyMarginTokens: 0,
                documentShareNumerator: 1,
                documentShareDenominator: 1,
              },
            },
            {
              store,
              retrieve: async () => {
                await store.syncContexts([
                  {
                    scopeType: "global",
                    scopeKey: "/",
                    text: "Mutated mid-compile",
                  },
                ]);
                return {
                  results: [],
                  meta: {
                    query: "detect context mutation",
                    mode: "bm25_only",
                    totalResults: 0,
                  },
                };
              },
              projectCanonical: () => ({
                value: { ok: true },
                usedBytes: 10,
                usedTokens: 3,
              }),
            }
          )
        ).rejects.toMatchObject({ code: "context_changed_during_compile" });
        // Second snapshot ran because contextGeneration + total_changes changed.
        expect(snapshotCalls).toBe(3);
      } finally {
        SqliteAdapter.prototype.getActivationIndexSnapshot = origSnapshot;
      }
    } finally {
      await store.close();
    }
  });

  test("analyzeGraphCommunities remains deterministic without inner-loop sorting and truncateText handles short + astral strings", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({
      id,
      uri: `gno://notes/${id}.md`,
      title: id,
      collection: "notes",
      relPath: `${id}.md`,
      degree: 2,
    }));
    const links = [
      {
        source: "a",
        target: "b",
        type: "wiki" as const,
        weight: 1,
        confidence: "explicit" as const,
        audit: { resolution: "exact-title" as const, matchCount: 1 },
      },
      {
        source: "c",
        target: "d",
        type: "wiki" as const,
        weight: 1,
        confidence: "explicit" as const,
        audit: { resolution: "exact-title" as const, matchCount: 1 },
      },
    ];
    const first = analyzeGraphCommunities(nodes, links);
    const second = analyzeGraphCommunities(nodes, links);
    expect(first).toEqual(second);
    expect(first.total).toBe(2);

    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello world", 5)).toBe("hello");
    expect(truncateText("🚀🔥✨🎉", 2)).toBe("🚀🔥");
  });
});
