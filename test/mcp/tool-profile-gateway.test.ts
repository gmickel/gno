/**
 * Regression: `--mcp-tool-profile` must reach the resident gateway config
 * from both `gno daemon` and `gno serve` (the override object each builds
 * for resolveHttpGatewayConfig is explicit, so a missing key silently falls
 * back to gateway.toolProfile / full).
 */

import { expect, mock, test } from "bun:test";

import type { ResolvedHttpGatewayConfig } from "../../src/mcp/http-security";

import { daemon } from "../../src/cli/commands/daemon";
import { startServer } from "../../src/serve/server";

function runtimeWithGateway(gateway: Record<string, unknown> | undefined) {
  return {
    success: true as const,
    runtime: {
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [],
        contexts: [],
        gateway,
      },
      store: {},
      actualConfigPath: "/tmp/gno-profile-gateway/index.yml",
      ctxHolder: { current: {}, config: { collections: [] } },
      scheduler: {},
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
      },
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
        embedResult: { embedded: 0, errors: 0 },
      }),
      dispose: async () => undefined,
    },
  };
}

function capturingGateway(captured: { config?: ResolvedHttpGatewayConfig }) {
  return (async (_runtime: unknown, config: ResolvedHttpGatewayConfig) => {
    captured.config = config;
    return {
      route: async () => new Response("ok"),
      close: async () => undefined,
      security: {},
      transport: {},
    };
  }) as never;
}

test("daemon passes --mcp-tool-profile through as the gateway override", async () => {
  const cases: Array<{
    gateway: Record<string, unknown> | undefined;
    flag: "core" | "full" | undefined;
    expected: "core" | "full";
  }> = [
    { gateway: undefined, flag: undefined, expected: "full" },
    { gateway: { toolProfile: "core" }, flag: undefined, expected: "core" },
    { gateway: { toolProfile: "core" }, flag: "full", expected: "full" },
    { gateway: undefined, flag: "core", expected: "core" },
  ];
  for (const { gateway, flag, expected } of cases) {
    const captured: { config?: ResolvedHttpGatewayConfig } = {};
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    const result = await daemon(
      { signal: controller.signal, noSyncOnStart: true, toolProfile: flag },
      {
        startBackgroundRuntime: (async () =>
          runtimeWithGateway(gateway)) as never,
        createMcpHttpGateway: capturingGateway(captured),
        serve: (() => ({ port: 3000, stop: async () => undefined })) as never,
        logger: { log: () => undefined, error: () => undefined },
      }
    );
    expect(result).toEqual({ success: true });
    expect(captured.config?.toolProfile).toBe(expected);
  }
});

test("serve passes --mcp-tool-profile through as the gateway override", async () => {
  const captured: { config?: ResolvedHttpGatewayConfig } = {};
  const stop = mock(async () => undefined);
  const result = await startServer(
    { port: 3210, toolProfile: "core" },
    {
      startBackgroundRuntime: (async () =>
        runtimeWithGateway({ toolProfile: "full" })) as never,
      createMcpHttpGateway: capturingGateway(captured),
      serve: (() => ({ port: 3210, stop })) as never,
      waitForShutdown: async () => undefined,
    }
  );
  expect(result).toEqual({ success: true });
  expect(captured.config?.toolProfile).toBe("core");
});
