import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import type { Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { createTestOnlyMcpRoute } from "../../src/serve/routes/mcp";
import { startServer } from "../../src/serve/server";

const MCP_URL = "http://127.0.0.1:3210/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-11-25";

interface TestRuntime extends HttpMcpTransportRuntime {
  readonly admitted: number;
  readonly sessions: number;
  beginShutdown(): void;
}

function createToolContext(): ToolContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61" as const,
    collections: [],
    contexts: [],
  };
  return {
    store: {} as ToolContext["store"],
    config,
    collections: [],
    actualConfigPath: "/tmp/gno-http-test/config.yml",
    indexName: "test",
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {} as ToolContext["jobManager"],
    serverInstanceId: "http-test",
    writeLockPath: "/tmp/gno-http-test/.lock",
    enableWrite: false,
    isShuttingDown: () => false,
  };
}

function createRuntime(): TestRuntime {
  let admitted = 0;
  let sessions = 0;
  let shuttingDown = false;
  return {
    mcpContext: createToolContext(),
    get admitted() {
      return admitted;
    },
    get sessions() {
      return sessions;
    },
    get isShuttingDown() {
      return shuttingDown;
    },
    beginShutdown() {
      shuttingDown = true;
    },
    admitRequest() {
      if (shuttingDown) return null;
      admitted += 1;
      let finished = false;
      return {
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        finish() {
          if (finished) return;
          finished = true;
          admitted -= 1;
        },
      };
    },
    openSession() {
      sessions += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        sessions -= 1;
      };
    },
  };
}

function postRequest(body: unknown, sessionId?: string): Request {
  const headers = new Headers({
    accept: MCP_ACCEPT,
    "content-type": "application/json",
  });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", PROTOCOL_VERSION);
  }
  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function initialize(
  transport: HttpMcpTransport,
  id = 1
): Promise<string> {
  const response = await transport.handleRequest(
    postRequest({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: `test-client-${id}`, version: "1.0.0" },
      },
    })
  );
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  expect(sessionId).toMatch(/^[\x21-\x7e]+$/);
  await response.text();
  return sessionId!;
}

function getRequest(sessionId?: string, lastEventId?: string): Request {
  const headers = new Headers({ accept: "text/event-stream" });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", PROTOCOL_VERSION);
  }
  if (lastEventId) headers.set("last-event-id", lastEventId);
  return new Request(MCP_URL, { headers });
}

function deleteRequest(sessionId?: string): Request {
  const headers = new Headers();
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", PROTOCOL_VERSION);
  }
  return new Request(MCP_URL, { method: "DELETE", headers });
}

async function createClient(
  transport: HttpMcpTransport,
  name: string
): Promise<Client> {
  const http = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => transport.handleRequest(new Request(input, init)),
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(http);
  return client;
}

const openTransports: HttpMcpTransport[] = [];
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(
    openClients.splice(0).map((client) => client.close())
  );
  await Promise.allSettled(
    openTransports.splice(0).map((transport) => transport.close())
  );
});

describe("stateful Web Standard MCP transport", () => {
  test("isolates two concurrent client sessions over one resident runtime", async () => {
    const runtime = createRuntime();
    let serversCreated = 0;
    const transport = new HttpMcpTransport(runtime, {
      createServer: () => {
        serversCreated += 1;
        let calls = 0;
        const server = new McpServer({ name: "isolation", version: "1.0.0" });
        server.registerTool(
          "session-counter",
          { inputSchema: {} },
          async () => ({
            content: [{ type: "text", text: String(++calls) }],
            structuredContent: { calls },
          })
        );
        return server;
      },
    });
    openTransports.push(transport);

    const [clientA, clientB] = await Promise.all([
      createClient(transport, "client-a"),
      createClient(transport, "client-b"),
    ]);
    openClients.push(clientA, clientB);

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "session-counter", arguments: {} }),
      clientB.callTool({ name: "session-counter", arguments: {} }),
    ]);
    expect(resultA.structuredContent).toEqual({ calls: 1 });
    expect(resultB.structuredContent).toEqual({ calls: 1 });
    expect(serversCreated).toBe(2);
    expect(transport.activeSessions).toBe(2);
    expect(runtime.sessions).toBe(2);
  });

  test("handles GET, DELETE, protocol versions, and terminated sessions", async () => {
    const runtime = createRuntime();
    const transport = new HttpMcpTransport(runtime, {
      createServer: () => new McpServer({ name: "lifecycle", version: "1" }),
    });
    openTransports.push(transport);
    const sessionId = await initialize(transport);

    const invalidVersion = postRequest(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      sessionId
    );
    invalidVersion.headers.set("mcp-protocol-version", "2099-01-01");
    expect((await transport.handleRequest(invalidVersion)).status).toBe(400);

    const stream = await transport.handleRequest(getRequest(sessionId));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
    await Bun.sleep(0);
    expect(transport.activeRequests).toBe(0);
    expect(runtime.admitted).toBe(0);

    const terminated = await transport.handleRequest(deleteRequest(sessionId));
    expect(terminated.status).toBe(200);
    expect(transport.activeSessions).toBe(0);
    expect(runtime.sessions).toBe(0);
    expect((await transport.handleRequest(getRequest(sessionId))).status).toBe(
      404
    );
  });

  test("returns stable malformed, missing, unknown, and resumption errors", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "errors", version: "1" }),
    });
    openTransports.push(transport);

    const malformed = await transport.handleRequest(postRequest("{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: -32_700, message: "Parse error: Invalid JSON" },
    });
    const unsupportedMediaType = postRequest({});
    unsupportedMediaType.headers.set("content-type", "text/plain");
    expect((await transport.handleRequest(unsupportedMediaType)).status).toBe(
      415
    );
    const unacceptable = postRequest({});
    unacceptable.headers.set("accept", "application/json");
    expect((await transport.handleRequest(unacceptable)).status).toBe(406);
    expect(
      (await transport.handleRequest(new Request(MCP_URL, { method: "PUT" })))
        .status
    ).toBe(405);
    expect((await transport.handleRequest(getRequest())).status).toBe(400);
    expect(
      (await transport.handleRequest(getRequest("unknown-session"))).status
    ).toBe(404);

    const sessionId = await initialize(transport);
    const resume = await transport.handleRequest(
      getRequest(sessionId, "event-that-does-not-exist")
    );
    expect(resume.status).toBe(400);
    expect(await resume.json()).toMatchObject({
      error: { message: "MCP event resumption is not supported" },
    });
  });

  test("reaps idle sessions and rejects session or request overload", async () => {
    let now = 10;
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "bounds", version: "1" }),
      idleTimeoutMs: 50,
      maxConcurrentRequests: 1,
      maxSessions: 1,
      now: () => now,
    });
    openTransports.push(transport);
    const sessionId = await initialize(transport);

    const heldStream = await transport.handleRequest(getRequest(sessionId));
    expect(transport.activeRequests).toBe(1);
    expect((await transport.handleRequest(getRequest(sessionId))).status).toBe(
      429
    );
    await heldStream.body?.cancel();
    await Bun.sleep(0);

    expect(
      (
        await transport.handleRequest(
          postRequest({
            jsonrpc: "2.0",
            id: 9,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "overload", version: "1" },
            },
          })
        )
      ).status
    ).toBe(429);

    now = 100;
    expect(await transport.reapIdleSessions()).toBe(1);
    expect(transport.activeSessions).toBe(0);
    expect((await transport.handleRequest(getRequest(sessionId))).status).toBe(
      404
    );
  });

  test("propagates MCP cancellation without crossing session boundaries", async () => {
    const runtime = createRuntime();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let cancelled = false;
    const transport = new HttpMcpTransport(runtime, {
      createServer: () => {
        const server = new McpServer({ name: "cancel", version: "1" });
        server.registerTool(
          "wait",
          { inputSchema: { label: z.string() } },
          async (_args, extra) => {
            startedResolve?.();
            await new Promise<void>((resolve) => {
              extra.signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  resolve();
                },
                { once: true }
              );
            });
            return { content: [{ type: "text", text: "cancelled" }] };
          }
        );
        return server;
      },
    });
    openTransports.push(transport);
    const client = await createClient(transport, "cancel-client");
    openClients.push(client);

    const controller = new AbortController();
    const call = client.callTool(
      { name: "wait", arguments: { label: "one" } },
      undefined,
      { signal: controller.signal }
    );
    await started;
    controller.abort("test cancellation");
    const rejection = await call.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
    expect(transport.activeSessions).toBe(1);
  });

  test("keeps the route test-only and disables Bun idle timeouts when injected", async () => {
    const capturedRoutes: Array<Record<string, unknown>> = [];
    const stop = mock(async () => undefined);
    const dispose = mock(async () => undefined);
    const runtime = {
      actualConfigPath: "/tmp/config.yml",
      store: {},
      ctxHolder: { current: {}, config: { collections: [] } },
      eventBus: null,
      dispose,
    };
    const startBackgroundRuntime = mock(async () => ({
      success: true as const,
      runtime,
    }));
    const serve = ((options: { routes: Record<string, unknown> }) => {
      capturedRoutes.push(options.routes);
      return { port: 3210, stop } as never;
    }) as never;

    await startServer(
      {},
      {
        startBackgroundRuntime: startBackgroundRuntime as never,
        serve,
        waitForShutdown: async () => undefined,
      }
    );
    expect(capturedRoutes[0]?.["/mcp"]).toBeUndefined();

    const handleRequest = mock(async () => new Response("ok"));
    const route = createTestOnlyMcpRoute({ handleRequest } as never);
    await startServer(
      {},
      {
        startBackgroundRuntime: startBackgroundRuntime as never,
        serve,
        waitForShutdown: async () => undefined,
        unsafeTestOnlyMcpRoute: route,
      }
    );
    expect(capturedRoutes[1]?.["/mcp"]).toBe(route);

    const timeout = mock(() => undefined);
    const request = postRequest({});
    await route.POST(request, { timeout });
    expect(timeout).toHaveBeenCalledWith(request, 0);
    expect(handleRequest).toHaveBeenCalledWith(request);
  });

  test("rejects requests after resident shutdown starts", async () => {
    const runtime = createRuntime();
    const transport = new HttpMcpTransport(runtime);
    openTransports.push(transport);
    runtime.beginShutdown();
    const response = await transport.handleRequest(postRequest({}));
    expect(response.status).toBe(503);
  });
});
