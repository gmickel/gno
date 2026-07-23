import { describe, expect, mock, spyOn, test } from "bun:test";

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
    createEmbedScheduler: (options) =>
      ({
        notifySyncComplete: () => undefined,
        triggerNow: async () => {
          const result = { embedded: 2, errors: 0 };
          options.onEmbedded?.(result);
          return result;
        },
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
        getLifecycleStats: () => ({
          activeLeases: 0,
          leaseAcquisitions: 2,
          leaseReleases: 2,
          loadedModels: 1,
          loadAttempts: 1,
          loadSuccesses: 1,
          loadFailures: 0,
          inflightLoads: 0,
        }),
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
    runtime.setListenerPort(3210);
    runtime.setTransportStatusProvider(() => ({
      activeRequests: 1,
      activeSessions: 2,
      queuedRequests: 1,
      maxConcurrentRequests: 8,
      maxQueuedRequests: 4,
      maxSessions: 16,
    }));
    expect(runtime.getStatus()).toMatchObject({
      mode: "serve",
      listenerPort: 3210,
      transport: {
        activeRequests: 1,
        activeSessions: 2,
        queuedRequests: 1,
      },
      models: {
        loadedModels: 1,
        loadAttempts: 1,
        leaseAcquisitions: 2,
        leaseReleases: 2,
      },
      generations: { content: 2, index: 1 },
    });
    await runtime.dispose();
  });

  test("watcher mutations advance the shared content generation", async () => {
    const deps = createDeps();
    let callbacks:
      | Parameters<
          NonNullable<ResidentRuntimeDeps["watchServiceFactory"]>
        >[0]["callbacks"]
      | undefined;
    const baseFactory = deps.watchServiceFactory!;
    deps.watchServiceFactory = (options) => {
      callbacks = options.callbacks;
      return baseFactory(options);
    };
    const result = await startResidentRuntime({ mode: "serve" }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;

    callbacks?.onSyncComplete?.({
      collection: "notes",
      relPaths: ["changed.md"],
      result: {
        collection: "notes",
        filesProcessed: 1,
        filesAdded: 0,
        filesUpdated: 1,
        filesUnchanged: 0,
        filesErrored: 0,
        filesSkipped: 0,
        filesMarkedInactive: 0,
        durationMs: 1,
        errors: [],
      },
    });
    expect(result.runtime.generations.content).toBe(1);
    await result.runtime.dispose();
  });

  test("schedules saved Capsule reverification after watcher and full-sync settlement", async () => {
    const deps = createDeps();
    let callbacks:
      | Parameters<
          NonNullable<ResidentRuntimeDeps["watchServiceFactory"]>
        >[0]["callbacks"]
      | undefined;
    const baseFactory = deps.watchServiceFactory!;
    deps.watchServiceFactory = (options) => {
      callbacks = options.callbacks;
      return baseFactory(options);
    };
    const result = await startResidentRuntime({ mode: "serve" }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const notify = spyOn(
      result.runtime.capsuleReverificationScheduler,
      "notifySyncSettled"
    ).mockImplementation(() => undefined);
    callbacks?.onSettled?.();
    await result.runtime.syncAll();
    expect(notify).toHaveBeenCalledTimes(2);

    await result.runtime.dispose();
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

    const result = await startResidentRuntime(
      { shutdownDeadlineMs: 0, shutdownAbortSettleMs: 100 },
      deps
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const request = result.runtime.admitRequest();
    expect(request).not.toBeNull();
    request?.signal.addEventListener(
      "abort",
      () => {
        calls.push("handler");
        request.finish();
      },
      { once: true }
    );
    expect(
      result.runtime.startBackgroundWork(
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                calls.push("background");
                resolve();
              },
              { once: true }
            );
          })
      )
    ).toBe(true);
    const closeSession = result.runtime.openSession();
    // HttpMcpSessionStore is the sole active-session counter. The runtime
    // session hook intentionally contributes no duplicate accounting.
    expect(result.runtime.activeSessions).toBe(0);
    closeSession();
    await result.runtime.dispose();

    expect(calls.indexOf("handler")).toBeLessThan(calls.indexOf("context"));
    expect(calls.indexOf("handler")).toBeLessThan(calls.indexOf("store"));
    expect(calls.indexOf("background")).toBeLessThan(
      calls.indexOf("scheduler")
    );
    expect(calls.indexOf("scheduler")).toBeLessThan(calls.indexOf("context"));
    expect(calls.indexOf("context")).toBeLessThan(calls.indexOf("models"));
    expect(calls.indexOf("models")).toBeLessThan(calls.indexOf("store"));
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
