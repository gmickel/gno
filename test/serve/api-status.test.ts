import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { ServerContext } from "../../src/serve/context";
import type { AppStatusResponse } from "../../src/serve/status-model";

import { handleStatus } from "../../src/serve/routes/api";

function createMockContext(): ServerContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    models: {
      activePreset: "slim",
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
      presets: [
        {
          id: "slim",
          name: "Slim (Default, ~1GB)",
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
    expect(body.health.checks).toHaveLength(4);
    expect(body.activePreset.id).toBe("slim");
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
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as AppStatusResponse;

    expect(body.onboarding.ready).toBe(true);
    expect(body.health.state).toBe("healthy");
    expect(body.healthy).toBe(true);
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
});
