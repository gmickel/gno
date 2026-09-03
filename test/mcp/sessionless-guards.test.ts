/**
 * Guard parity on the 2026-07-28 sessionless HTTP path.
 *
 * One focused test per boundary guard proves the modern leg runs through the
 * SAME enforcement as the stateful 2025 path: authentication, write gate,
 * egress, concurrency admission, authorization-epoch invalidation, identity
 * isolation, and transport metrics. A raw SDK handler that skipped any of
 * these would be a security regression, so each guard is observed on a real
 * 2026-enveloped request. The long-lived `subscriptions/listen` stream the
 * SDK router would serve is refused before dispatch, so it can never pin a
 * capacity slot or an admission handle.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { classifyDestination } from "../../src/core/destination-classifier";
import { createToolContext } from "../../src/mcp/context";
import {
  HttpMcpSecurity,
  resolveHttpGatewayConfig,
} from "../../src/mcp/http-security";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { createStandaloneResidentStatus } from "../../src/serve/resident-status";
import { modernHeaders, modernRequest } from "../helpers/mcp-wire";

const MCP_URL = "http://127.0.0.1:3210/mcp";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const METHOD_NOT_FOUND = -32_601;
const LOCAL_ONLY_COLLECTION = {
  name: "notes",
  path: "/tmp/gno-sessionless/notes",
  pattern: "**/*.md",
  include: [],
  exclude: [],
  egressPolicy: "local_only" as const,
};

interface TestRuntime extends HttpMcpTransportRuntime {
  readonly admitted: number;
  authorizationEpoch: string;
  beginShutdown(): void;
}

function createContext(enableWrite = false): ToolContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [{ ...LOCAL_ONLY_COLLECTION }],
    contexts: [],
  };
  return createToolContext({
    store: {} as never,
    getConfig: () => config,
    actualConfigPath: "/tmp/gno-sessionless/config.yml",
    indexName: "sessionless",
    toolMutex: { acquire: async () => () => undefined },
    jobManager: {} as never,
    serverInstanceId: "sessionless",
    writeLockPath: "/tmp/gno-sessionless/.lock",
    enableWrite,
    isShuttingDown: () => false,
    getResidentStatus: () => createStandaloneResidentStatus("stdio"),
  });
}

function createRuntime(enableWrite = false): TestRuntime {
  let admitted = 0;
  let shuttingDown = false;
  const runtime: TestRuntime = {
    mcpContext: createContext(enableWrite),
    authorizationEpoch: "egress-epoch-v1:one",
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
      const requestEpoch = runtime.authorizationEpoch;
      let finished = false;
      return {
        authorizationEpoch: requestEpoch,
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        isAuthorizationEpochCurrent: () =>
          requestEpoch === runtime.authorizationEpoch,
        finish() {
          if (finished) return;
          finished = true;
          admitted -= 1;
        },
      };
    },
    openSession: () => () => undefined,
  };
  return runtime;
}

/** Minimal surface: a read tool, a write-named tool, and a gated slow tool. */
function createEchoServer(
  hooks: {
    onSlowStarted?: () => void;
    slowRelease?: Promise<void>;
    onRotate?: () => Promise<void>;
  } = {}
) {
  return (context: ToolContext): McpServer => {
    const server = new McpServer({ name: "guards", version: "1" });
    server.registerTool(
      "gno_get",
      { inputSchema: z.object({ ref: z.string() }) },
      async ({ ref }) => ({ content: [{ type: "text", text: `read ${ref}` }] })
    );
    server.registerTool(
      "gno_capture",
      { inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "write reached" }] })
    );
    server.registerTool("slow", { inputSchema: z.object({}) }, async () => {
      hooks.onSlowStarted?.();
      await hooks.slowRelease;
      return { content: [{ type: "text", text: "stale-secret" }] };
    });
    server.registerTool(
      "rotate-policy",
      { inputSchema: z.object({}) },
      async () => {
        await hooks.onRotate?.();
        context.advanceRequestAuthorizationEpoch?.("egress-epoch-v1:two");
        return { content: [{ type: "text", text: "revision:2" }] };
      }
    );
    return server;
  };
}

function modernCall(
  id: number,
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { ...modernHeaders("tools/call", name), ...extraHeaders },
    body: JSON.stringify(
      modernRequest(id, "tools/call", { name, arguments: args })
    ),
  });
}

function modernListen(id: number): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: modernHeaders("subscriptions/listen"),
    body: JSON.stringify(
      modernRequest(id, "subscriptions/listen", {
        subscriptions: [{ method: "notifications/resources/list_changed" }],
      })
    ),
  });
}

function legacyInitialize(id: number): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
    }),
  });
}

function legacyToolsList(id: number, sessionId: string): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": LEGACY_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: {},
    }),
  });
}

const remotePeer = classifyDestination({
  kind: "network",
  hostname: "203.0.113.1",
});
const loopbackPeer = classifyDestination({
  kind: "network",
  hostname: "127.0.0.1",
});

const openTransports: HttpMcpTransport[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(openTransports.splice(0).map((t) => t.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("2026-07-28 sessionless path guard parity", () => {
  test("authentication: the bearer boundary runs before the modern leg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-sessionless-auth-"));
    tempDirs.push(dir);
    const tokenPath = join(dir, "token");
    const token = "b".repeat(64);
    await Bun.write(tokenPath, `${token}\n`);
    await chmod(tokenPath, 0o600);
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        tokenFile: tokenPath,
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
      })
    );
    await security.initialize();
    const peer = {
      requestIP: () => ({ address: "192.0.2.5", port: 50_000 }),
      timeout: () => undefined,
    };
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer(),
    });
    openTransports.push(transport);
    const body = modernRequest(1, "tools/list");
    const headers = {
      ...modernHeaders("tools/list"),
      host: "gateway.example.test:3000",
    };

    const anonymous = await security.authorize(
      new Request(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      peer
    );
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);

    const authorized = await security.authorize(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      peer
    );
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    // The production route hands the transport a body-less sanitized request
    // plus the pre-parsed body; the modern leg must serve exactly that shape.
    expect(authorized.value.request.body).toBeNull();
    const response = await transport.handleRequest(authorized.value.request, {
      authenticated: authorized.value.authenticated,
      identity: authorized.value.identity,
      parsedBody: authorized.value.parsedBody,
      peerClassification: authorized.value.peerClassification,
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result: { tools: unknown[] } };
    expect(payload.result.tools.length).toBeGreaterThan(0);
  });

  test("write gate: write tools need --enable-write on the modern leg too", async () => {
    const readOnly = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer(),
      enableWrite: false,
    });
    openTransports.push(readOnly);
    const denied = await readOnly.handleRequest(
      modernCall(1, "gno_capture", { secret: "do-not-echo" })
    );
    expect(denied.status).toBe(403);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain('"message":"Forbidden"');
    expect(deniedBody).not.toContain("do-not-echo");

    const writable = new HttpMcpTransport(createRuntime(true), {
      createServer: createEchoServer(),
      enableWrite: true,
    });
    openTransports.push(writable);
    const allowed = await writable.handleRequest(modernCall(1, "gno_capture"));
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("write reached");
  });

  test("egress: collection policy is evaluated against the actual peer zone", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer(),
    });
    openTransports.push(transport);
    const args = { ref: "gno://notes/private.md" };
    const remote = await transport.handleRequest(
      modernCall(1, "gno_get", args),
      {
        authenticated: true,
        identity: "bearer",
        peerClassification: remotePeer,
      }
    );
    expect(remote.status).toBe(403);
    expect(await remote.text()).toContain("EGRESS_DENIED");

    const loopback = await transport.handleRequest(
      modernCall(2, "gno_get", args),
      { identity: "loopback", peerClassification: loopbackPeer }
    );
    expect(loopback.status).toBe(200);
    expect(await loopback.text()).toContain("read gno://notes/private.md");
  });

  test("admission: shutdown and capacity limits apply to modern requests", async () => {
    const runtime = createRuntime();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = new HttpMcpTransport(runtime, {
      createServer: createEchoServer({
        onSlowStarted: () => started?.(),
        slowRelease: new Promise<void>((resolve) => {
          release = resolve;
        }),
      }),
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
    });
    openTransports.push(transport);

    const held = transport.handleRequest(modernCall(1, "slow"));
    await slowStarted;
    expect(runtime.admitted).toBe(1);
    const overflow = await transport.handleRequest(
      modernCall(2, "gno_get", { ref: "gno://notes/a.md" })
    );
    expect(overflow.status).toBe(429);
    release?.();
    expect((await held).status).toBe(200);
    expect(runtime.admitted).toBe(0);

    runtime.beginShutdown();
    const refused = await transport.handleRequest(
      modernCall(3, "gno_get", { ref: "gno://notes/a.md" })
    );
    expect(refused.status).toBe(503);
  });

  test("authorization epoch: a policy change mid-call denies the stale modern response", async () => {
    const runtime = createRuntime(true);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = new HttpMcpTransport(runtime, {
      enableWrite: true,
      createServer: createEchoServer({
        onSlowStarted: () => started?.(),
        slowRelease: new Promise<void>((resolve) => {
          release = resolve;
        }),
        onRotate: async () => {
          runtime.authorizationEpoch = "egress-epoch-v1:two";
          await transport.invalidateAuthenticatedSessions();
        },
      }),
    });
    openTransports.push(transport);

    const slow = transport.handleRequest(modernCall(1, "slow"));
    await slowStarted;
    const setter = await transport.handleRequest(
      modernCall(2, "rotate-policy")
    );
    expect(setter.status).toBe(200);
    expect(await setter.text()).toContain("revision:2");
    release?.();
    const denied = await slow;
    expect(denied.status).toBe(409);
    const deniedBody = await denied.text();
    expect(deniedBody).toContain("EGRESS_POLICY_CHANGED");
    expect(deniedBody).not.toContain("stale-secret");
  });

  test("identity isolation: a modern request can neither create nor borrow a session", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer(),
    });
    openTransports.push(transport);
    const initialized = await transport.handleRequest(legacyInitialize(1), {
      identity: "principal-a",
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id")!;
    await initialized.text();
    expect(transport.activeSessions).toBe(1);

    const borrowed = await transport.handleRequest(
      modernCall(
        2,
        "gno_get",
        { ref: "gno://notes/a.md" },
        { "mcp-session-id": sessionId }
      ),
      { identity: "principal-b", peerClassification: loopbackPeer }
    );
    expect(borrowed.status).toBe(400);
    expect(await borrowed.text()).toContain("Mcp-Session-Id is not valid");

    const own = await transport.handleRequest(
      modernCall(3, "gno_get", { ref: "gno://notes/a.md" }),
      { identity: "principal-b", peerClassification: loopbackPeer }
    );
    expect(own.status).toBe(200);
    expect(own.headers.get("mcp-session-id")).toBeNull();
    await own.text();
    expect(transport.activeSessions).toBe(1);

    // Principal A's session survived the confused-deputy attempt untouched.
    const stillAlive = await transport.handleRequest(
      legacyToolsList(4, sessionId),
      { identity: "principal-a" }
    );
    expect(stillAlive.status).toBe(200);
    await stillAlive.text();
  });

  test("subscriptions/listen: refused before dispatch, releasing the slot and admission handle", async () => {
    const runtime = createRuntime();
    const transport = new HttpMcpTransport(runtime, {
      createServer: createEchoServer(),
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
    });
    openTransports.push(transport);

    const refused = await transport.handleRequest(modernListen(7));
    expect(refused.status).toBe(404);
    expect(refused.headers.get("content-type")).toContain("application/json");
    const payload = (await refused.json()) as {
      id: unknown;
      error: { code: number; message: string; data?: unknown };
    };
    expect(payload.id).toBe(7);
    expect(payload.error.code).toBe(METHOD_NOT_FOUND);
    expect(payload.error.message).toContain("subscriptions/listen");
    expect(payload.error.data).toEqual({ method: "subscriptions/listen" });

    // Nothing outlives the answer: the only slot and the admission handle are
    // both free again, so the next request is admitted rather than 429'd.
    expect(runtime.admitted).toBe(0);
    expect(transport.getStatus()).toMatchObject({
      activeRequests: 0,
      activeSessions: 0,
      queuedRequests: 0,
    });
    const next = await transport.handleRequest(
      modernCall(8, "gno_get", { ref: "gno://notes/a.md" })
    );
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("read gno://notes/a.md");
    expect(runtime.admitted).toBe(0);
  });

  test("subscriptions/listen: invalidateAuthenticatedSessions still closes exactly the sessions", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer(),
    });
    openTransports.push(transport);
    const initialized = await transport.handleRequest(legacyInitialize(1), {
      identity: "principal-a",
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id")!;
    await initialized.text();
    expect(transport.activeSessions).toBe(1);

    const refused = await transport.handleRequest(modernListen(2), {
      identity: "principal-b",
    });
    expect(refused.status).toBe(404);
    await refused.text();
    // The refused stream neither created nor touched a session.
    expect(transport.activeSessions).toBe(1);

    await transport.invalidateAuthenticatedSessions();
    expect(transport.activeSessions).toBe(0);
    expect(transport.activeRequests).toBe(0);
    const gone = await transport.handleRequest(legacyToolsList(3, sessionId), {
      identity: "principal-a",
    });
    expect(gone.status).toBe(404);
    await gone.text();
  });

  test("transport metrics: modern requests count as active requests, never as sessions", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: createEchoServer({
        onSlowStarted: () => started?.(),
        slowRelease: new Promise<void>((resolve) => {
          release = resolve;
        }),
      }),
    });
    openTransports.push(transport);
    const inFlight = transport.handleRequest(modernCall(1, "slow"));
    await slowStarted;
    expect(transport.getStatus()).toMatchObject({
      activeRequests: 1,
      activeSessions: 0,
      queuedRequests: 0,
    });
    release?.();
    await (await inFlight).text();
    expect(transport.getStatus()).toMatchObject({
      activeRequests: 0,
      activeSessions: 0,
    });
  });
});
