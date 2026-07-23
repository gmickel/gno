import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import type { Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { createStandaloneResidentStatus } from "../../src/serve/resident-status";
import { startServer } from "../../src/serve/server";

const MCP_URL = "http://127.0.0.1:3210/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2025-11-25";

interface TestRuntime extends HttpMcpTransportRuntime {
  readonly admitted: number;
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
    getResidentStatus: () => createStandaloneResidentStatus("stdio"),
  };
}

function createRuntime(): TestRuntime {
  let admitted = 0;
  let shuttingDown = false;
  return {
    mcpContext: createToolContext(),
    get admitted() {
      return admitted;
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
      return () => undefined;
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
  id = 1,
  identity = "loopback"
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
    }),
    { identity }
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
    let sharedStoreCalls = 0;
    let warmModelLoads = 0;
    let modelWarm = false;
    const transport = new HttpMcpTransport(runtime, {
      createServer: () => {
        serversCreated += 1;
        let calls = 0;
        const server = new McpServer({ name: "isolation", version: "1.0.0" });
        server.registerTool(
          "session-counter",
          { inputSchema: {} },
          async () => {
            sharedStoreCalls += 1;
            if (!modelWarm) {
              modelWarm = true;
              warmModelLoads += 1;
            }
            return {
              content: [{ type: "text", text: String(++calls) }],
              structuredContent: { calls },
            };
          }
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
    expect(sharedStoreCalls).toBe(2);
    expect(warmModelLoads).toBe(1);
    expect(transport.activeSessions).toBe(2);
    expect(transport.getStatus()).toMatchObject({
      activeSessions: 2,
      maxConcurrentRequests: 64,
      maxQueuedRequests: 0,
      maxSessions: 32,
    });
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

  test("mounts the production route and preserves per-request SSE timeout control", async () => {
    const capturedRoutes: Array<Record<string, unknown>> = [];
    const stop = mock(async () => undefined);
    const dispose = mock(async () => undefined);
    const runtime = {
      actualConfigPath: "/tmp/config.yml",
      config: { collections: [] },
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

    const handleRequest = mock(async (_request: Request) => new Response("ok"));
    const route = mock(
      async (
        request: Request,
        server: { timeout(req: Request, seconds: number): void }
      ) => {
        server.timeout(request, 0);
        return handleRequest(request);
      }
    );
    const close = mock(async () => undefined);
    await startServer(
      {},
      {
        startBackgroundRuntime: startBackgroundRuntime as never,
        createMcpHttpGateway: (async () => ({
          route,
          close,
          security: {},
          transport: {},
        })) as never,
        serve,
        waitForShutdown: async () => undefined,
      }
    );
    expect(capturedRoutes[0]?.["/mcp"]).toBe(route);
    const traceJudgmentRoute = capturedRoutes[0]?.[
      "/api/traces/:traceId/judgments"
    ] as { POST(request: Request): Promise<Response> };
    const deniedTraceMutation = await traceJudgmentRoute.POST(
      new Request("http://127.0.0.1:3000/api/traces/secret-trace/judgments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          label: "relevant",
          targetRef: "gno://private/secret.md",
        }),
      })
    );
    expect(deniedTraceMutation.status).toBe(403);
    const deniedBody = await deniedTraceMutation.text();
    expect(deniedBody).not.toContain("secret-trace");
    expect(deniedBody).not.toContain("private/secret");

    const timeout = mock(() => undefined);
    const request = postRequest({});
    await route(request, { timeout });
    expect(timeout).toHaveBeenCalledWith(request, 0);
    expect(handleRequest).toHaveBeenCalledWith(request);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("rejects requests after resident shutdown starts", async () => {
    const runtime = createRuntime();
    const transport = new HttpMcpTransport(runtime);
    openTransports.push(transport);
    runtime.beginShutdown();
    const response = await transport.handleRequest(postRequest({}));
    expect(response.status).toBe(503);
  });

  test("binds sessions to one authenticated identity", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "identity", version: "1" }),
    });
    openTransports.push(transport);
    const sessionId = await initialize(transport, 1, "principal-a");

    const confused = await transport.handleRequest(getRequest(sessionId), {
      identity: "principal-b",
    });
    expect(confused.status).toBe(403);
    expect(
      (
        await transport.handleRequest(getRequest(sessionId), {
          identity: "principal-a",
        })
      ).status
    ).toBe(404);
  });

  test("rejects HTTP mutation calls unless separately authorized", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "read-only", version: "1" }),
      enableWrite: false,
    });
    openTransports.push(transport);
    const authenticatedIdentity = "bearer:authenticated-reader";
    const sessionId = await initialize(transport, 1, authenticatedIdentity);
    const reads = await transport.handleRequest(
      postRequest(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId
      ),
      { identity: authenticatedIdentity }
    );
    expect(reads.status).toBe(200);
    await reads.text();
    for (const name of ["gno_capture", "gno_trace_delete"]) {
      const response = await transport.handleRequest(
        postRequest(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: { traceId: "secret-trace" } },
          },
          sessionId
        ),
        { identity: authenticatedIdentity }
      );
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain('"message":"Forbidden"');
      expect(body).not.toContain("secret-trace");
    }
  });

  test("bounds the request queue and releases it on stream completion", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "queue", version: "1" }),
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
    });
    openTransports.push(transport);
    const sessionId = await initialize(transport);
    const held = await transport.handleRequest(getRequest(sessionId));
    const queued = transport.handleRequest(getRequest(sessionId));
    await Bun.sleep(0);
    expect(transport.queuedRequests).toBe(1);
    expect((await transport.handleRequest(getRequest(sessionId))).status).toBe(
      429
    );

    await held.body?.cancel();
    const admitted = await queued;
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
  });

  test("invalidates all sessions when credentials rotate", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => new McpServer({ name: "rotation", version: "1" }),
    });
    openTransports.push(transport);
    const sessionId = await initialize(transport, 1, "old-token");
    expect(transport.activeSessions).toBe(1);
    await transport.invalidateAuthenticatedSessions();
    expect(transport.activeSessions).toBe(0);
    expect(
      (
        await transport.handleRequest(getRequest(sessionId), {
          identity: "old-token",
        })
      ).status
    ).toBe(404);
  });
});
