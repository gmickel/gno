import { expect, mock, test } from "bun:test";
// node:path resolve has no Bun equivalent for canonical config path assertions.
import { resolve } from "node:path";

import { ENV_CONFIG_DIR } from "../../src/app/constants";
import { getConfigPaths } from "../../src/config";
import { startServer } from "../../src/serve/server";

interface CapturedServeOptions {
  routes: Record<
    string,
    { POST: (request: Request) => Response | Promise<Response> }
  >;
}

async function runConnectorInstallRoute(actualConfigPath: string): Promise<{
  installConnector: ReturnType<typeof mock>;
  startRuntime: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
}> {
  let capturedOptions: CapturedServeOptions | undefined;
  const dispose = mock(async () => undefined);
  const stop = mock(async () => undefined);
  const startRuntime = mock(async () => ({
    success: true as const,
    runtime: {
      actualConfigPath,
      config: { collections: [] },
      store: {},
      ctxHolder: {
        current: {},
        config: { collections: [] },
      },
      dispose,
    },
  }));
  const installConnector = mock(async () =>
    Response.json({ connector: { installed: true } })
  );

  const result = await startServer(
    { index: "client-work", port: 3210 },
    {
      startBackgroundRuntime: startRuntime as never,
      createMcpHttpGateway: (async () => ({
        route: async () => new Response("ok"),
        close: async () => undefined,
        security: {},
        transport: {},
      })) as never,
      serve: ((options: unknown) => {
        capturedOptions = options as CapturedServeOptions;
        return { port: 3210, stop } as never;
      }) as never,
      handleInstallConnector: installConnector as never,
      waitForShutdown: async () => {
        const route = capturedOptions?.routes["/api/connectors/install"];
        expect(route).toBeDefined();
        const response = await route?.POST(
          new Request("http://127.0.0.1:3210/api/connectors/install", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connectorId: "claude-desktop-mcp" }),
          })
        );
        expect(response?.status).toBe(200);
      },
    }
  );

  expect(result).toEqual({ success: true });
  return { installConnector, startRuntime, dispose, stop };
}

test("serve connector install route forwards env-resolved runtime config", async () => {
  const previousConfigDir = process.env[ENV_CONFIG_DIR];
  process.env[ENV_CONFIG_DIR] = "/tmp/gno-env-config";

  try {
    const actualConfigPath = resolve(getConfigPaths().configFile);
    const { installConnector, startRuntime, dispose, stop } =
      await runConnectorInstallRoute(actualConfigPath);

    expect(startRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: undefined, index: "client-work" })
    );
    expect(installConnector).toHaveBeenCalledTimes(1);
    expect(installConnector).toHaveBeenCalledWith(expect.any(Request), {
      indexName: "client-work",
      configPath: actualConfigPath,
    });
    expect(stop).toHaveBeenCalledWith(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env[ENV_CONFIG_DIR];
    } else {
      process.env[ENV_CONFIG_DIR] = previousConfigDir;
    }
  }
});

test("serve connector install route also pins the resolved default config", async () => {
  const previousConfigDir = process.env[ENV_CONFIG_DIR];
  delete process.env[ENV_CONFIG_DIR];

  try {
    const actualConfigPath = resolve(getConfigPaths().configFile);
    const { installConnector } =
      await runConnectorInstallRoute(actualConfigPath);

    expect(installConnector).toHaveBeenCalledWith(expect.any(Request), {
      indexName: "client-work",
      configPath: actualConfigPath,
    });
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env[ENV_CONFIG_DIR];
    } else {
      process.env[ENV_CONFIG_DIR] = previousConfigDir;
    }
  }
});

test("serve rejects non-loopback binding before opening the shared Web/REST listener", async () => {
  const dispose = mock(async () => undefined);
  const createMcpHttpGateway = mock(async () => {
    throw new Error("must not initialize gateway");
  });
  const serve = mock(() => {
    throw new Error("must not open listener");
  });
  const result = await startServer(
    {
      host: "0.0.0.0",
      tokenFile: "/tmp/gno-unused-token",
      allowedHosts: ["workstation.example:3000"],
      allowedOrigins: ["https://agent.example"],
    },
    {
      startBackgroundRuntime: (async () => ({
        success: true as const,
        runtime: {
          actualConfigPath: "/tmp/config/index.yml",
          config: { collections: [] },
          store: {},
          ctxHolder: { current: {}, config: { collections: [] } },
          dispose,
        },
      })) as never,
      createMcpHttpGateway: createMcpHttpGateway as never,
      serve: serve as never,
    }
  );

  expect(result).toEqual({
    success: false,
    error:
      "gno serve remains loopback-only because Web and REST share its listener; use gno daemon for authenticated non-loopback MCP",
  });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(createMcpHttpGateway).toHaveBeenCalledTimes(0);
  expect(serve).toHaveBeenCalledTimes(0);
});
