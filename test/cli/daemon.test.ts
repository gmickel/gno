import { describe, expect, mock, test } from "bun:test";

import {
  authorizeDaemonStatus,
  daemon,
  handleDaemonAppStatus,
} from "../../src/cli/commands/daemon";
import { classifyDestination } from "../../src/core/destination-classifier";

type StartBackgroundRuntimeFn =
  typeof import("../../src/serve/background-runtime").startBackgroundRuntime;

function gatewayDeps() {
  return {
    createMcpHttpGateway: (async () => ({
      route: async () => new Response("ok"),
      close: async () => undefined,
      security: {},
      transport: {},
    })) as never,
    serve: (() => ({ port: 3000, stop: async () => undefined })) as never,
  };
}

describe("daemon command", () => {
  test("stop during stuck initial sync reaches teardown without awaiting startup", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let disposed = false;
    const running = daemon(
      { signal: controller.signal, quiet: true },
      {
        ...gatewayDeps(),
        startBackgroundRuntime: (async () => ({
          success: true,
          runtime: {
            config: {
              version: "1.0",
              ftsTokenizer: "unicode61",
              collections: [],
              contexts: [],
            },
            syncAll: async () => {
              entered.resolve();
              await new Promise(() => {});
            },
            dispose: async () => {
              disposed = true;
            },
            setListenerPort: () => {},
            watchService: {
              getState: () => ({
                expectedCollections: [],
                activeCollections: [],
                failedCollections: [],
              }),
            },
          },
        })) as never,
        logger: { log: () => {}, error: () => {} },
      }
    );
    await entered.promise;
    controller.abort();
    expect(await running).toEqual({ success: true });
    expect(disposed).toBe(true);
  });

  test("denies path-bearing app status on non-loopback listeners", async () => {
    const response = await handleDaemonAppStatus({} as never, "0.0.0.0");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("intersects bearer authentication and collection policy for resident status", async () => {
    const runtime = {
      config: {
        collections: [
          {
            name: "notes",
            path: "/notes",
            pattern: "**/*",
            include: [],
            exclude: [],
            egressPolicy: "local_only",
          },
        ],
      },
      getStatus: () => ({ schemaVersion: "1.0" }),
    };
    const gateway = {
      security: {
        authorize: async () => ({
          ok: true as const,
          value: {
            authenticated: true,
            identity: "principal",
            peerClassification: classifyDestination({
              kind: "network",
              hostname: "8.8.8.8",
            }),
            request: new Request("http://gno.example/api/resident/status"),
          },
        }),
      },
    };
    const response = await authorizeDaemonStatus(
      runtime as never,
      gateway as never,
      new Request("http://gno.example/api/resident/status"),
      {} as never
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("EGRESS_DENIED");
  });

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
    const cleanupOrder: string[] = [];
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
    const dispose = mock(async () => {
      cleanupOrder.push("runtime");
    });

    setTimeout(() => {
      controller.abort();
    }, 0);

    const result = await daemon(
      {
        signal: controller.signal,
      },
      {
        createMcpHttpGateway: (async () => ({
          route: async () => new Response("ok"),
          close: async () => {
            cleanupOrder.push("gateway");
          },
          security: {},
          transport: {},
        })) as never,
        serve: (() => ({
          port: 3000,
          stop: async () => {
            cleanupOrder.push("server");
          },
        })) as never,
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
    expect(cleanupOrder).toEqual(["runtime", "server", "gateway"]);
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
        ...gatewayDeps(),
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

  test("passes offline flag through to background runtime", async () => {
    const startBackgroundRuntime = mock(
      async () =>
        ({
          success: true as const,
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
            syncAll: async () => ({
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
            }),
            dispose: async () => undefined,
          },
        }) satisfies Awaited<ReturnType<StartBackgroundRuntimeFn>>
    ) as unknown as StartBackgroundRuntimeFn;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    await daemon(
      {
        offline: true,
        signal: controller.signal,
      },
      {
        ...gatewayDeps(),
        startBackgroundRuntime,
      }
    );

    expect(startBackgroundRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        offline: true,
      })
    );
  });
});
