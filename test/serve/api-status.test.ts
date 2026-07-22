import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { ActivationStatus } from "../../src/core/activation-status";
import type { ServerContext } from "../../src/serve/context";
import type { AppStatusResponse } from "../../src/serve/status-model";

import { handleHealth, handleStatus } from "../../src/serve/routes/api";

function activationStatus(
  collections: string[],
  ready = true
): ActivationStatus {
  return {
    schemaVersion: "1.0",
    usable: ready && collections.length > 0,
    healthy: ready && collections.length > 0,
    collections: collections.map((collection) => ({
      collection,
      ready,
      generatedAt: "2026-07-22T10:00:00.000Z",
      stages: {
        index: {
          status: ready ? "passed" : "failed",
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
          ...(!ready ? { code: "no_documents" as const } : {}),
        },
        lexical: {
          status: ready ? "passed" : "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
          ...(!ready ? { code: "no_documents" as const } : {}),
        },
        semantic: {
          status: "pending",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "semantic_not_checked",
        },
        connector: {
          status: "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "connector_not_requested",
        },
      },
      semanticAvailability: {
        status: "pending",
        code: "semantic_not_checked",
        command: "gno status",
      },
      remediation: ready
        ? null
        : {
            stage: "index",
            code: "no_documents",
            command: `gno index ${collection} --no-embed`,
            message: "Index at least one supported text document.",
          },
    })),
    connectors: [],
    connectorProjection: { total: 0, projected: 0, truncated: false },
  };
}

function createMockContext(): ServerContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    models: {
      activePreset: "slim-tuned",
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
      presets: [
        {
          id: "slim-tuned",
          name: "GNO Slim Tuned (Default, ~1GB)",
          embed: "hf:embed",
          rerank: "hf:rerank",
          expand: "hf:expand",
          gen: "hf:gen",
        },
      ],
    },
  };

  return {
    config,
    answerPort: null,
    capabilities: {
      answer: false,
      bm25: true,
      hybrid: false,
      vector: false,
    },
    embedPort: null,
    expandPort: null,
    rerankPort: null,
    store: {
      getStatus: async () => ({
        ok: true as const,
        value: {
          version: "1.0",
          indexName: "default",
          configPath: "/tmp/config.yml",
          dbPath: "/tmp/index.sqlite",
          ftsTokenizer: "unicode61",
          collections: [],
          totalDocuments: 0,
          activeDocuments: 0,
          totalChunks: 0,
          embeddingBacklog: 0,
          recentErrors: 0,
          lastUpdatedAt: null,
          healthy: true,
        },
      }),
    } as never,
    vectorIndex: null,
  };
}

describe("GET /api/status", () => {
  test("keeps /api/health as liveness-only", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("returns onboarding and health metadata for first run", async () => {
    const ctx = createMockContext();
    const res = await handleStatus(ctx, {
      inspectDisk: async () => ({
        freeBytes: 8 * 1024 * 1024 * 1024,
        totalBytes: 16 * 1024 * 1024 * 1024,
        path: "/tmp",
      }),
      isModelCached: async () => false,
      listSuggestedCollections: async () => [
        {
          label: "Documents",
          path: "/Users/test/Documents",
          reason: "Good default for notes and docs",
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AppStatusResponse;

    expect(body.onboarding.stage).toBe("add-collection");
    expect(body.onboarding.suggestedCollections).toHaveLength(1);
    expect(body.health.state).toBe("setup-required");
    expect(body.health.checks).toHaveLength(5);
    expect(body.activation).toEqual(activationStatus([]));
    expect(body.activePreset.id).toBe("slim-tuned");
    expect(body.capabilities.answer).toBe(false);
    expect(body.background.watcher.expectedCollections).toEqual([]);
    expect(body.background.embedding.available).toBe(false);
    expect(body.background.events.retryMs).toBe(0);
    expect(body.bootstrap.runtime.kind).toBe("bun");
    expect(body.bootstrap.models.totalCount).toBe(4);
    expect(body.bootstrap.policy.allowDownload).toBe(true);
  });

  test("marks healthy workspace when folders, models, and index are ready", async () => {
    const ctx = createMockContext();
    ctx.capabilities = {
      answer: true,
      bm25: true,
      hybrid: true,
      vector: true,
    };
    ctx.config.collections = [
      {
        name: "notes",
        path: "/tmp/notes",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    ctx.store = {
      getStatus: async () => ({
        ok: true as const,
        value: {
          version: "1.0",
          indexName: "default",
          configPath: "/tmp/config.yml",
          dbPath: "/tmp/index.sqlite",
          ftsTokenizer: "unicode61",
          collections: [
            {
              name: "notes",
              path: "/tmp/notes",
              totalDocuments: 3,
              activeDocuments: 3,
              errorDocuments: 0,
              chunkedDocuments: 3,
              totalChunks: 12,
              embeddedChunks: 12,
            },
          ],
          totalDocuments: 3,
          activeDocuments: 3,
          totalChunks: 12,
          embeddingBacklog: 0,
          recentErrors: 0,
          lastUpdatedAt: "2026-03-22T15:00:00Z",
          healthy: true,
        },
      }),
    } as never;

    const res = await handleStatus(ctx, {
      inspectDisk: async () => ({
        freeBytes: 12 * 1024 * 1024 * 1024,
        totalBytes: 16 * 1024 * 1024 * 1024,
        path: "/tmp",
      }),
      isModelCached: async () => true,
      listSuggestedCollections: async () => [],
      buildActivation: async () => activationStatus(["notes"]),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AppStatusResponse;

    expect(body.onboarding.ready).toBe(true);
    expect(body.onboarding.steps.map((step) => step.id)).not.toContain(
      "models"
    );
    expect(body.health.state).toBe("healthy");
    expect(body.healthy).toBe(true);
    expect(body.activation.healthy).toBe(true);
    expect(body.onboarding.detail).toContain("lexical retrieval");
    expect(body.collections[0]).toEqual({
      name: "notes",
      path: "/tmp/notes",
      documentCount: 3,
      chunkCount: 12,
      embeddedCount: 12,
    });
    expect(body.background.watcher.activeCollections).toEqual([]);
    expect(body.bootstrap.models.cachedCount).toBe(0);
  });

  test("renders mixed lexical and connector outcomes without a false green", async () => {
    const ctx = createMockContext();
    ctx.config.collections = [
      {
        name: "alpha",
        path: "/tmp/alpha",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "zeta",
        path: "/tmp/zeta",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    ctx.store = {
      getStatus: async () => ({
        ok: true as const,
        value: {
          version: "1.0",
          indexName: "default",
          configPath: "/tmp/config.yml",
          dbPath: "/tmp/index.sqlite",
          ftsTokenizer: "unicode61" as const,
          collections: ctx.config.collections.map(({ name, path }) => ({
            name,
            path,
            totalDocuments: 1,
            activeDocuments: 1,
            errorDocuments: 0,
            chunkedDocuments: 1,
            totalChunks: 1,
            embeddedChunks: 0,
          })),
          totalDocuments: 2,
          activeDocuments: 2,
          totalChunks: 2,
          embeddingBacklog: 2,
          recentErrors: 0,
          lastUpdatedAt: "2026-07-22T10:00:00.000Z",
          healthy: true,
        },
      }),
    } as never;
    const passed = activationStatus(["zeta"]);
    const failed = activationStatus(["alpha"], false);
    const activation: ActivationStatus = {
      schemaVersion: "1.0",
      usable: true,
      healthy: false,
      collections: [...failed.collections, ...passed.collections],
      connectors: [
        {
          collection: "zeta",
          target: "cursor-mcp",
          status: "failed",
          code: "connector_timeout",
          remediation: "Retry cursor-mcp verification.",
        },
      ],
      connectorProjection: { total: 1, projected: 1, truncated: false },
    };

    const response = await handleStatus(ctx, {
      inspectDisk: async () => ({
        freeBytes: 8 * 1024 * 1024 * 1024,
        totalBytes: 16 * 1024 * 1024 * 1024,
        path: "/tmp",
      }),
      isModelCached: async () => false,
      listSuggestedCollections: async () => [],
      buildActivation: async () => activation,
    });
    const body = (await response.json()) as AppStatusResponse;
    expect(body.activation).toMatchObject({ usable: true, healthy: false });
    expect(body.onboarding.ready).toBe(false);
    expect(body.onboarding.detail).toContain("alpha: index/no_documents");
    expect(body.onboarding.detail).toContain("gno index alpha --no-embed");
    expect(
      body.health.checks.find(({ id }) => id === "retrieval-activation")
    ).toMatchObject({ status: "warn" });
    expect(
      body.health.checks.find(({ id }) => id === "connector-activation")
    ).toMatchObject({ status: "error" });
    expect(body.healthy).toBe(false);
  });

  test("surfaces preserved vector runtime diagnostics without logging", async () => {
    const ctx = createMockContext();
    ctx.vectorIndex = {
      searchAvailable: false,
      model: "embed-model",
      dimensions: 384,
      loadError: "dlopen failed for vec0",
      guidance: "Run `gno doctor` and verify sqlite-vec.",
      vecDirty: false,
    } as never;
    const originalWarn = console.warn;
    let warningCount = 0;
    console.warn = () => {
      warningCount += 1;
    };

    try {
      const responses = await Promise.all([
        handleStatus(ctx, {
          inspectDisk: async () => ({
            freeBytes: 8 * 1024 * 1024 * 1024,
            totalBytes: 16 * 1024 * 1024 * 1024,
            path: "/tmp",
          }),
          isModelCached: async () => true,
          listSuggestedCollections: async () => [],
        }),
        handleStatus(ctx, {
          inspectDisk: async () => ({
            freeBytes: 8 * 1024 * 1024 * 1024,
            totalBytes: 16 * 1024 * 1024 * 1024,
            path: "/tmp",
          }),
          isModelCached: async () => true,
          listSuggestedCollections: async () => [],
        }),
      ]);
      const body = (await responses[0]?.json()) as AppStatusResponse;
      const vectorCheck = body.health.checks.find(
        (check) => check.id === "vector-runtime"
      );
      expect(vectorCheck?.status).toBe("warn");
      expect(vectorCheck?.detail).toContain("dlopen failed for vec0");
      expect(vectorCheck?.detail).toContain("gno doctor");
      expect(warningCount).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("coalesces concurrent status builds for one server context", async () => {
    const ctx = createMockContext();
    let statusCalls = 0;
    ctx.store = {
      getStatus: async () => {
        statusCalls += 1;
        await Bun.sleep(10);
        return {
          ok: true as const,
          value: {
            version: "1.0",
            indexName: "default",
            configPath: "/tmp/config.yml",
            dbPath: "/tmp/index.sqlite",
            ftsTokenizer: "unicode61" as const,
            collections: [],
            totalDocuments: 0,
            activeDocuments: 0,
            totalChunks: 0,
            embeddingBacklog: 0,
            recentErrors: 0,
            lastUpdatedAt: null,
            healthy: true,
          },
        };
      },
    } as never;
    const deps = {
      inspectDisk: async () => ({
        freeBytes: 8 * 1024 * 1024 * 1024,
        totalBytes: 16 * 1024 * 1024 * 1024,
        path: "/tmp",
      }),
      isModelCached: async () => true,
      listSuggestedCollections: async () => [],
    };

    const responses = await Promise.all([
      handleStatus(ctx, deps),
      handleStatus(ctx, deps),
      handleStatus(ctx, deps),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(statusCalls).toBe(1);
  });
});
