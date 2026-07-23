import { describe, expect, mock, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type { ResidentRuntimeDeps } from "../../src/serve/resident-runtime";

import { startResidentRuntime } from "../../src/serve/resident-runtime";

const config: Config = {
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    {
      name: "notes",
      path: "/tmp/notes",
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
};

const syncResult = {
  collections: [],
  totalDurationMs: 1,
  totalFilesProcessed: 1,
  totalFilesAdded: 1,
  totalFilesUpdated: 0,
  totalFilesErrored: 0,
  totalFilesSkipped: 0,
};

function createDeps(calls: string[] = []): ResidentRuntimeDeps {
  const store = {
    setConfigPath: () => undefined,
    open: async () => ({ ok: true as const, value: undefined }),
    syncCollections: async () => ({ ok: true as const, value: undefined }),
    syncContexts: async () => ({ ok: true as const, value: undefined }),
    getRawDb: () => ({}),
    close: async () => {
      calls.push("store");
    },
  };
  return {
    isInitialized: async () => true,
    loadConfig: async () => ({ ok: true, value: config }) as never,
    ensureDirectories: async () => ({ ok: true, value: undefined }) as never,
    getConfigPaths: () =>
      ({
        configDir: "/tmp/config",
        configFile: "/tmp/config/index.yml",
        dataDir: "/tmp/data",
        cacheDir: "/tmp/cache",
      }) as never,
    acquireOwnerLock: async () => ({
      release: async () => {
        calls.push("owner");
      },
    }),
    storeFactory: () => store as never,
    createServerContext: async () =>
      ({
        store,
        config,
        indexName: "default",
        vectorIndex: null,
        embedPort: null,
        expandPort: null,
        answerPort: null,
        rerankPort: null,
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
      }) as never,
    disposeServerContext: async () => {
      calls.push("context");
    },
    createEmbedScheduler: () =>
      ({
        notifySyncComplete: () => undefined,
        triggerNow: async () => ({ embedded: 2, errors: 0 }),
        getState: () => ({ pendingDocCount: 0, running: false }),
        dispose: () => {
          calls.push("scheduler");
        },
      }) as never,
    syncAllService: async () => syncResult,
    watchServiceFactory: () =>
      ({
        start: () => undefined,
        updateCollections: () => undefined,
        dispose: () => {
          calls.push("watch");
        },
        getState: () => ({
          expectedCollections: ["notes"],
          activeCollections: ["notes"],
          failedCollections: [],
          queuedCollections: [],
          syncingCollections: [],
          lastEventAt: null,
          lastSyncAt: null,
        }),
      }) as never,
    modelManagerFactory: () =>
      ({
        disposeAll: async () => {
          calls.push("models");
        },
      }) as never,
  };
}

describe("ResidentRuntime", () => {
  test("fails a second serve/daemon owner with a stable status hint", async () => {
    const acquireOwnerLock = mock(async () => null);
    const result = await startResidentRuntime(
      { mode: "daemon" },
      { ...createDeps(), acquireOwnerLock }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(
        'Resident runtime already active for index "default". Stop the owning gno serve or gno daemon process and retry.'
      );
    }
    expect(acquireOwnerLock).toHaveBeenCalledTimes(1);
  });

  test("owns one shared jobs/MCP context and monotonic generations", async () => {
    const result = await startResidentRuntime({ mode: "serve" }, createDeps());
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { runtime } = result;
    expect(runtime.mcpContext.jobManager).toBe(runtime.jobManager);
    expect(runtime.generations).toEqual({ content: 0, index: 0 });
    await runtime.syncAll();
    expect(runtime.generations).toEqual({ content: 1, index: 1 });
    await runtime.syncAll({ triggerEmbed: false });
    expect(runtime.generations).toEqual({ content: 2, index: 1 });
    await runtime.dispose();
  });

  test("closes admission, cancels overdue requests, and settles every cleanup", async () => {
    const calls: string[] = [];
    const deps = createDeps(calls);
    deps.disposeServerContext = async () => {
      calls.push("context");
      throw new Error("context cleanup failed");
    };
    deps.watchServiceFactory = () =>
      ({
        start: () => undefined,
        updateCollections: () => undefined,
        dispose: () => {
          calls.push("watch");
          throw new Error("watch cleanup failed");
        },
        getState: () => ({
          expectedCollections: [],
          activeCollections: [],
          failedCollections: [],
          queuedCollections: [],
          syncingCollections: [],
          lastEventAt: null,
          lastSyncAt: null,
        }),
      }) as never;

    const result = await startResidentRuntime({ shutdownDeadlineMs: 0 }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const request = result.runtime.admitRequest();
    expect(request).not.toBeNull();
    const closeSession = result.runtime.openSession();
    expect(result.runtime.activeSessions).toBe(1);
    await result.runtime.dispose();

    expect(request?.signal.aborted).toBe(true);
    expect(result.runtime.admitRequest()).toBeNull();
    expect(result.runtime.activeRequests).toBe(0);
    expect(result.runtime.activeSessions).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        "watch",
        "scheduler",
        "context",
        "models",
        "store",
        "owner",
      ])
    );
    closeSession();
    expect(result.runtime.activeSessions).toBe(0);
  });
});
