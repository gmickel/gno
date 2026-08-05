import { describe, expect, mock, test } from "bun:test";

import {
  authorizeDaemonStatus,
  daemon,
  formatWatchCause,
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
    expect(cleanupOrder).toEqual(["server", "gateway", "runtime"]);
  });

  test("logs watcher reconciliation diagnostics from the new callbacks", async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    let watchCallbacks:
      | import("../../src/serve/watch-service").CollectionWatchCallbacks
      | undefined;

    setTimeout(() => {
      controller.abort();
    }, 0);

    const result = await daemon(
      { noSyncOnStart: true, signal: controller.signal, verbose: true },
      {
        ...gatewayDeps(),
        startBackgroundRuntime: (async (
          startOptions: Parameters<StartBackgroundRuntimeFn>[0]
        ) => {
          watchCallbacks = startOptions?.watchCallbacks;
          return {
            success: true,
            runtime: {
              config: { collections: [] },
              store: {} as never,
              actualConfigPath: "/tmp/config/index.yml",
              ctxHolder: {} as never,
              scheduler: {} as never,
              eventBus: null,
              watchService: {
                getState: () => ({
                  expectedCollections: [],
                  activeCollections: [],
                  failedCollections: [],
                  queuedCollections: [],
                  syncingCollections: [],
                  lastEventAt: null,
                  lastSyncAt: null,
                }),
              } as never,
              syncAll: async () => ({ syncResult: null, embedResult: null }),
              dispose: async () => undefined,
            },
          };
        }) as unknown as StartBackgroundRuntimeFn,
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
    // The daemon is the production consumer of the fn-114 diagnostics: without
    // this wiring the events would exist only in tests.
    watchCallbacks?.onAmbiguousEvent?.({
      collection: "notes",
      directory: "",
      reason: "ineligible-path",
    });
    watchCallbacks?.onAmbiguousEvent?.({
      collection: "notes",
      directory: null,
      reason: "missing-filename",
    });
    watchCallbacks?.onReconcileStart?.({
      collection: "notes",
      // Untrusted filenames must not carry control characters into a log line.
      directory: "dir1/we\u0007ird",
    });
    watchCallbacks?.onReconcileComplete?.({
      collection: "notes",
      directory: "dir1",
      candidateCount: 2,
      syncedCount: 2,
    });
    watchCallbacks?.onReconcileFailed?.({
      collection: "notes",
      directory: "dir1",
      stage: "enumerate",
      cause: new Error("EACCES"),
    });
    // A store failure hands over a structured StoreError, not an Error: a bare
    // `String(cause)` renders it `[object Object]` and the diagnostic is
    // useless exactly when it matters.
    watchCallbacks?.onReconcileFailed?.({
      collection: "notes",
      directory: "dir1",
      stage: "store",
      cause: { code: "QUERY_FAILED", message: "store offline" },
    });
    // A filesystem cause embeds the untrusted path in its message, so leaving
    // it raw would undo the sanitization already applied to `directory`.
    watchCallbacks?.onReconcileFailed?.({
      collection: "notes",
      directory: "dir2",
      stage: "enumerate",
      cause: Object.assign(
        new Error("EACCES: permission denied, scandir 'dir2/we\u0007ird'"),
        { code: "EACCES" }
      ),
    });

    expect(
      logs.some((line) =>
        line.includes(
          "watch ambiguous event: notes (ineligible-path) -> <collection root>"
        )
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "watch ambiguous event: notes (missing-filename) -> <unknown>"
        )
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes("watch reconcile started: notes -> dir1/we?ird")
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "watch reconciled: notes -> dir1 (2 candidates, 2 synced)"
        )
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "ERR:watch reconcile failed (enumerate): notes -> dir1: EACCES"
        )
      )
    ).toBe(true);
    // Structured store cause: code + message, never `[object Object]`.
    expect(
      logs.some((line) =>
        line.includes(
          "ERR:watch reconcile failed (store): notes -> dir1: QUERY_FAILED: store offline"
        )
      )
    ).toBe(true);
    expect(logs.some((line) => line.includes("[object Object]"))).toBe(false);
    // Filesystem cause: sanitized, and the code is not duplicated onto a
    // message that already leads with it.
    expect(
      logs.some((line) =>
        line.includes(
          "ERR:watch reconcile failed (enumerate): notes -> dir2: EACCES: permission denied, scandir 'dir2/we?ird'"
        )
      )
    ).toBe(true);
  });

  test("bounds and sanitizes every reconciliation cause shape", () => {
    // Structured StoreError - the shape `String(cause)` destroys.
    expect(
      formatWatchCause({ code: "QUERY_FAILED", message: "store offline" })
    ).toBe("QUERY_FAILED: store offline");
    // Filesystem Error carrying an untrusted path in its message.
    expect(
      formatWatchCause(
        Object.assign(new Error("ENOENT: no such file '/a\u0007b'"), {
          code: "ENOENT",
        })
      )
    ).toBe("ENOENT: no such file '/a?b'");
    // A code-less Error keeps its message verbatim.
    expect(formatWatchCause(new Error("plain failure"))).toBe("plain failure");
    // Nothing extractable degrades to a label, never `[object Object]`.
    expect(formatWatchCause({})).toBe("unknown cause");
    expect(formatWatchCause(undefined)).toBe("unknown cause");
    // Length is bounded: a 1000-character message cannot flood a log line.
    const flood = formatWatchCause(new Error("x".repeat(1000)));
    expect(flood.length).toBe(203);
    expect(flood.endsWith("...")).toBe(true);
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
