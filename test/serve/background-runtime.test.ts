import { describe, expect, mock, test } from "bun:test";

import { startBackgroundRuntime } from "../../src/serve/background-runtime";

describe("startBackgroundRuntime", () => {
  test("fails when collections are required but config is empty", async () => {
    const result = await startBackgroundRuntime(
      {
        requireCollections: true,
      },
      {
        isInitialized: async () => true,
        loadConfig: async () =>
          ({
            ok: true,
            value: {
              version: "1.0",
              ftsTokenizer: "unicode61",
              collections: [],
              contexts: [],
            },
          }) as never,
      }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("No collections configured");
    }
  });

  test("creates shared runtime and syncAll triggers embed", async () => {
    const setConfigPath = mock(() => undefined);
    const open = mock(async () => ({ ok: true, value: undefined }));
    const syncCollections = mock(async () => ({ ok: true, value: undefined }));
    const syncContexts = mock(async () => ({ ok: true, value: undefined }));
    const getRawDb = mock(() => ({}) as never);
    const close = mock(async () => undefined);
    const store = {
      setConfigPath,
      open,
      syncCollections,
      syncContexts,
      getRawDb,
      close,
    } as never;
    const disposeContext = mock(async () => undefined);
    const syncAllService = mock(async () => ({
      collections: [],
      totalDurationMs: 0,
      totalFilesProcessed: 0,
      totalFilesAdded: 0,
      totalFilesUpdated: 0,
      totalFilesErrored: 0,
      totalFilesSkipped: 0,
    }));
    const triggerNow = mock(async () => ({ embedded: 2, errors: 0 }));
    const schedulerDispose = mock(() => undefined);
    const scheduler = {
      notifySyncComplete: mock(() => undefined),
      triggerNow,
      getState: mock(() => ({ pendingDocCount: 0, running: false })),
      dispose: schedulerDispose,
    } as never;
    const watchDispose = mock(() => undefined);
    const watchService = {
      start: mock(() => undefined),
      dispose: watchDispose,
      getState: mock(() => ({
        expectedCollections: ["notes"],
        activeCollections: ["notes"],
        failedCollections: [],
        queuedCollections: [],
        syncingCollections: [],
        lastEventAt: null,
        lastSyncAt: null,
      })),
    } as never;

    const result = await startBackgroundRuntime(
      {},
      {
        isInitialized: async () => true,
        loadConfig: async () =>
          ({
            ok: true,
            value: {
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
              models: {
                activePreset: "slim-tuned",
                presets: [],
              },
            },
          }) as never,
        ensureDirectories: (async () => ({
          ok: true,
          value: undefined,
        })) as never,
        getConfigPaths: () =>
          ({
            configDir: "/tmp/config",
            configFile: "/tmp/config/index.yml",
            dataDir: "/tmp/data",
            cacheDir: "/tmp/cache",
          }) as never,
        storeFactory: () => store,
        createServerContext: async () =>
          ({
            store,
            config: {
              version: "1.0",
              ftsTokenizer: "unicode61",
              collections: [],
              contexts: [],
            },
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
        disposeServerContext: disposeContext,
        createEmbedScheduler: () => scheduler,
        syncAllService,
        watchServiceFactory: () => watchService,
      }
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const sync = await result.runtime.syncAll();
    expect(sync.embedResult).toEqual({ embedded: 2, errors: 0 });
    expect(syncAllService).toHaveBeenCalledTimes(1);
    expect(triggerNow).toHaveBeenCalledTimes(1);

    await result.runtime.dispose();
    expect(watchDispose).toHaveBeenCalledTimes(1);
    expect(schedulerDispose).toHaveBeenCalledTimes(1);
    expect(disposeContext).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("passes offline flag into server context creation", async () => {
    const createServerContext = mock(
      async () =>
        ({
          store: {} as never,
          config: {
            version: "1.0",
            ftsTokenizer: "unicode61",
            collections: [],
            contexts: [],
          },
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
        }) as never
    );

    const result = await startBackgroundRuntime(
      {
        offline: true,
      },
      {
        isInitialized: async () => true,
        loadConfig: async () =>
          ({
            ok: true,
            value: {
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
            },
          }) as never,
        ensureDirectories: (async () => ({
          ok: true,
          value: undefined,
        })) as never,
        getConfigPaths: () =>
          ({
            configDir: "/tmp/config",
            configFile: "/tmp/config/index.yml",
            dataDir: "/tmp/data",
            cacheDir: "/tmp/cache",
          }) as never,
        storeFactory: () =>
          ({
            setConfigPath: () => undefined,
            open: async () => ({ ok: true, value: undefined }),
            syncCollections: async () => ({ ok: true, value: undefined }),
            syncContexts: async () => ({ ok: true, value: undefined }),
            getRawDb: () => ({}) as never,
            close: async () => undefined,
          }) as never,
        createServerContext,
        createEmbedScheduler: () =>
          ({
            notifySyncComplete: () => undefined,
            triggerNow: async () => null,
            getState: () => ({ pendingDocCount: 0, running: false }),
            dispose: () => undefined,
          }) as never,
        watchServiceFactory: () =>
          ({
            start: () => undefined,
            dispose: () => undefined,
            getState: () => ({
              expectedCollections: [],
              activeCollections: [],
              failedCollections: [],
              queuedCollections: [],
              syncingCollections: [],
              lastEventAt: null,
              lastSyncAt: null,
            }),
          }) as never,
      }
    );

    expect(result.success).toBe(true);
    expect(createServerContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ offline: true })
    );
  });
});
