import { describe, expect, mock, test } from "bun:test";

import { daemon } from "../../src/cli/commands/daemon";

describe("daemon command", () => {
  test("returns startup errors from background runtime", async () => {
    const result = await daemon(
      {},
      {
        startBackgroundRuntime: async () => ({
          success: false,
          error: "GNO not initialized. Run: gno init",
        }),
      }
    );

    expect(result).toEqual({
      success: false,
      error: "GNO not initialized. Run: gno init",
    });
  });

  test("runs initial sync by default and disposes on stop signal", async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    const syncAll = mock(async () => ({
      syncResult: {
        collections: [
          {
            collection: "notes",
            filesProcessed: 1,
            filesAdded: 1,
            filesUpdated: 0,
            filesUnchanged: 0,
            filesErrored: 0,
            filesSkipped: 0,
            filesMarkedInactive: 0,
            durationMs: 12,
            errors: [],
          },
        ],
        totalDurationMs: 12,
        totalFilesProcessed: 1,
        totalFilesAdded: 1,
        totalFilesUpdated: 0,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      },
      embedResult: { embedded: 3, errors: 0 },
    }));
    const dispose = mock(async () => undefined);

    setTimeout(() => {
      controller.abort();
    }, 0);

    const result = await daemon(
      {
        signal: controller.signal,
      },
      {
        startBackgroundRuntime: async () => ({
          success: true,
          runtime: {
            config: {
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
            store: {} as never,
            actualConfigPath: "/tmp/config/index.yml",
            ctxHolder: {} as never,
            scheduler: {} as never,
            eventBus: null,
            watchService: {
              getState: () => ({
                expectedCollections: ["notes"],
                activeCollections: ["notes"],
                failedCollections: [],
                queuedCollections: [],
                syncingCollections: [],
                lastEventAt: null,
                lastSyncAt: null,
              }),
            } as never,
            syncAll,
            dispose,
          },
        }),
        logger: {
          log: (message) => {
            logs.push(message);
          },
          error: (message) => {
            logs.push(`ERR:${message}`);
          },
        },
      }
    );

    expect(result).toEqual({ success: true });
    expect(syncAll).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes("Running initial sync"))).toBe(
      true
    );
    expect(logs.some((line) => line.includes("embed: 3 embedded"))).toBe(true);
  });

  test("skips initial sync when requested", async () => {
    const controller = new AbortController();
    const syncAll = mock(async () => ({
      syncResult: {
        collections: [],
        totalDurationMs: 0,
        totalFilesProcessed: 0,
        totalFilesAdded: 0,
        totalFilesUpdated: 0,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      },
      embedResult: null,
    }));

    setTimeout(() => {
      controller.abort();
    }, 0);

    const result = await daemon(
      {
        noSyncOnStart: true,
        signal: controller.signal,
      },
      {
        startBackgroundRuntime: async () => ({
          success: true,
          runtime: {
            config: {
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
            store: {} as never,
            actualConfigPath: "/tmp/config/index.yml",
            ctxHolder: {} as never,
            scheduler: {} as never,
            eventBus: null,
            watchService: {
              getState: () => ({
                expectedCollections: ["notes"],
                activeCollections: ["notes"],
                failedCollections: [],
                queuedCollections: [],
                syncingCollections: [],
                lastEventAt: null,
                lastSyncAt: null,
              }),
            } as never,
            syncAll,
            dispose: async () => undefined,
          },
        }),
      }
    );

    expect(result).toEqual({ success: true });
    expect(syncAll).toHaveBeenCalledTimes(0);
  });
});
