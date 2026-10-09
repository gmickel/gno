/**
 * Gateway principals and asserted subjects: plumbing only. A named principal
 * maps its bearer token to a name; only a `mayAssertSubject` principal may
 * send `GNO-Subject` / `GNO-Context`, and the subject reaches the tool
 * context and the request-receipt namespace (as a hash).
 */

import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides POSIX mode mutation and temp-directory cleanup for tests.
import { chmod, mkdtemp, rm } from "node:fs/promises";
// node:os tmpdir and node:path join have no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Config } from "../../src/config/types";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { HttpGatewayConfigSchema } from "../../src/config/types";
import { httpMcpRequestNamespace } from "../../src/core/request-receipts";
import { createToolContext } from "../../src/mcp/context";
import {
  hashGatewaySubject,
  HttpMcpSecurity,
  resolveHttpGatewayConfig,
} from "../../src/mcp/http-security";
import { HttpMcpTransport } from "../../src/mcp/http-transport";

const MCP_URL = "http://127.0.0.1:3000/mcp";
const testDirs: string[] = [];
const openTransports: HttpMcpTransport[] = [];

const peer = {
  requestIP: () => ({ address: "127.0.0.1", port: 50_000 }),
  timeout: () => undefined,
};

async function tokenFile(dir: string, name: string, token: string) {
  const path = join(dir, name);
  await Bun.write(path, `${token}\n`);
  await chmod(path, 0o600);
  return path;
}

const PLUGIN_TOKEN = "p".repeat(64);
const READER_TOKEN = "r".repeat(64);
const PLAIN_TOKEN = "t".repeat(64);

async function principalSecurity(withPlainToken = false) {
  const dir = await mkdtemp(join(tmpdir(), "gno-http-principals-"));
  testDirs.push(dir);
  const security = new HttpMcpSecurity(
    resolveHttpGatewayConfig({
      ...(withPlainToken
        ? { tokenFile: await tokenFile(dir, "plain", PLAIN_TOKEN) }
        : {}),
      principals: [
        {
          name: "plugin",
          tokenFile: await tokenFile(dir, "plugin", PLUGIN_TOKEN),
          mayAssertSubject: true,
        },
        {
          name: "reader",
          tokenFile: await tokenFile(dir, "reader", READER_TOKEN),
          admin: true,
        },
      ],
    })
  );
  await security.initialize();
  return security;
}

function request(token: string | undefined, headers: Record<string, string>) {
  return new Request(MCP_URL, {
    headers: {
      host: "127.0.0.1:3000",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

afterEach(async () => {
  await Promise.allSettled(openTransports.splice(0).map((t) => t.close()));
  await Promise.all(
    testDirs.splice(0).map((dir) => rm(dir, { recursive: true }))
  );
});

describe("gateway principals config", () => {
  test("parses principals and rejects duplicate names or token files", () => {
    const one = { name: "plugin", tokenFile: "~/a", mayAssertSubject: true };
    expect(
      HttpGatewayConfigSchema.safeParse({ principals: [one] }).success
    ).toBe(true);
    expect(
      HttpGatewayConfigSchema.safeParse({
        principals: [one, { ...one, tokenFile: "~/b" }],
      }).success
    ).toBe(false);
    expect(
      HttpGatewayConfigSchema.safeParse({
        principals: [one, { ...one, name: "other" }],
      }).success
    ).toBe(false);
    expect(
      HttpGatewayConfigSchema.safeParse({
        principals: [{ name: "Bad Name", tokenFile: "~/a" }],
      }).success
    ).toBe(false);
  });

  test("resolved config has no principals key unless configured", () => {
    expect("principals" in resolveHttpGatewayConfig(undefined)).toBe(false);
    expect(
      resolveHttpGatewayConfig({
        principals: [{ name: "plugin", tokenFile: "~/a" }],
      }).principals
    ).toEqual([
      {
        name: "plugin",
        tokenFile: "~/a",
        mayAssertSubject: false,
        admin: false,
      },
    ]);
  });

  test("principals satisfy the non-loopback token requirement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-http-principals-"));
    testDirs.push(dir);
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        host: "0.0.0.0",
        allowedHosts: ["gateway.example.test:3000"],
        allowedOrigins: ["https://client.example.test"],
        principals: [
          {
            name: "plugin",
            tokenFile: await tokenFile(dir, "plugin", PLUGIN_TOKEN),
          },
        ],
      })
    );
    await security.initialize();
  });

  test("refuses two principals with the same token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-http-principals-"));
    testDirs.push(dir);
    const security = new HttpMcpSecurity(
      resolveHttpGatewayConfig({
        principals: [
          { name: "a", tokenFile: await tokenFile(dir, "a", PLUGIN_TOKEN) },
          { name: "b", tokenFile: await tokenFile(dir, "b", PLUGIN_TOKEN) },
        ],
      })
    );
    expect(security.initialize()).rejects.toThrow("distinct token");
  });
});

describe("gateway principals boundary", () => {
  test("maps each token to its principal and requires a token on loopback", async () => {
    const security = await principalSecurity();
    const reader = await security.authorize(request(READER_TOKEN, {}), peer);
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    expect(reader.value.authenticated).toBe(true);
    expect(reader.value.principal).toEqual({
      name: "reader",
      admin: true,
      mayAssertSubject: false,
    });
    expect(reader.value.subject).toBeUndefined();

    const missing = await security.authorize(request(undefined, {}), peer);
    expect(missing.ok ? 200 : missing.response.status).toBe(401);
    const wrong = await security.authorize(request("x".repeat(64), {}), peer);
    expect(wrong.ok ? 200 : wrong.response.status).toBe(401);
  });

  test("a principal token rotated to equal the plain token fails closed", async () => {
    const security = await principalSecurity(true);
    const plain = await security.authorize(request(PLAIN_TOKEN, {}), peer);
    expect(plain.ok).toBe(true);
    const plugin = testDirs.at(-1);
    if (!plugin) throw new Error("missing principal dir");
    // Rotate the plugin principal onto the plain token.
    await tokenFile(plugin, "plugin", PLAIN_TOKEN);
    for (const token of [PLAIN_TOKEN, PLUGIN_TOKEN]) {
      const result = await security.authorize(request(token, {}), peer);
      expect(result.ok ? 200 : result.response.status).toBe(401);
    }
    // An unrelated principal keeps working.
    const reader = await security.authorize(request(READER_TOKEN, {}), peer);
    expect(reader.ok && reader.value.principal?.name).toBe("reader");
    // Rotating away from the clash restores both credentials.
    await tokenFile(plugin, "plugin", PLUGIN_TOKEN);
    const restoredPlain = await security.authorize(
      request(PLAIN_TOKEN, {}),
      peer
    );
    expect(restoredPlain.ok && restoredPlain.value.principal).toBeUndefined();
    const restored = await security.authorize(request(PLUGIN_TOKEN, {}), peer);
    expect(restored.ok && restored.value.principal?.name).toBe("plugin");
  });

  test("a principal without mayAssertSubject that sends GNO-Subject gets 403", async () => {
    const security = await principalSecurity(true);
    for (const [token, headers] of [
      [READER_TOKEN, { "GNO-Subject": "u:alice" }],
      [READER_TOKEN, { "GNO-Context": "1to1" }],
      [PLAIN_TOKEN, { "GNO-Subject": "u:alice" }],
    ] as const) {
      const result = await security.authorize(request(token, headers), peer);
      expect(result.ok ? 200 : result.response.status).toBe(403);
    }
  });

  test("an asserting principal's subject is read, hashed and stripped", async () => {
    const security = await principalSecurity();
    const result = await security.authorize(
      request(PLUGIN_TOKEN, {
        "GNO-Subject": "u:00000000-0000-0000-0000-000000000001",
        "GNO-Context": "shared",
      }),
      peer
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.principal?.name).toBe("plugin");
    expect(result.value.subject).toEqual({
      id: "u:00000000-0000-0000-0000-000000000001",
      context: "shared",
      hash: hashGatewaySubject("u:00000000-0000-0000-0000-000000000001"),
    });
    expect(result.value.request.headers.has("gno-subject")).toBe(false);
    expect(result.value.request.headers.has("gno-context")).toBe(false);

    const noHeaders = await security.authorize(request(PLUGIN_TOKEN, {}), peer);
    expect(noHeaders.ok && noHeaders.value.subject).toBeUndefined();
  });

  test("malformed subject headers fail closed", async () => {
    const security = await principalSecurity();
    const cases: Array<Record<string, string>> = [
      { "GNO-Subject": "u alice" },
      { "GNO-Subject": "" },
      { "GNO-Subject": "u:alice", "GNO-Context": "everyone" },
      { "GNO-Context": "1to1" },
    ];
    for (const headers of cases) {
      const result = await security.authorize(
        request(PLUGIN_TOKEN, headers),
        peer
      );
      expect(result.ok ? 200 : result.response.status).toBe(403);
    }
  });

  test("without principals the headers are stripped and nothing changes", async () => {
    const security = new HttpMcpSecurity(resolveHttpGatewayConfig(undefined));
    await security.initialize();
    const result = await security.authorize(
      request(undefined, { "GNO-Subject": "u:alice", "GNO-Context": "1to1" }),
      peer
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identity).toBe("loopback");
    expect(result.value.authenticated).toBe(false);
    expect("principal" in result.value).toBe(false);
    expect("subject" in result.value).toBe(false);
    expect(result.value.request.headers.has("gno-subject")).toBe(false);
  });
});

describe("asserted subject in the tool context", () => {
  test("reaches the tool snapshot and keys the receipt namespace by hash", async () => {
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [],
      contexts: [],
    };
    const mcpContext = createToolContext({
      store: {} as never,
      getConfig: () => config,
      actualConfigPath: "/tmp/gno-principals/config.yml",
      indexName: "test",
      toolMutex: { acquire: async () => () => undefined } as never,
      jobManager: {} as never,
      serverInstanceId: "principals-test",
      writeLockPath: "/tmp/gno-principals/.lock",
      enableWrite: false,
      isShuttingDown: () => false,
    });
    const seen: unknown[] = [];
    const runtime: HttpMcpTransportRuntime = {
      mcpContext,
      isShuttingDown: false,
      admitRequest: () => ({
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        finish: () => undefined,
      }),
      openSession: () => () => undefined,
    } as HttpMcpTransportRuntime;
    const transport = new HttpMcpTransport(runtime, {
      createServer: () => {
        const server = new McpServer({ name: "principals", version: "1.0.0" });
        server.registerTool("whoami", { inputSchema: z.object({}) }, () => {
          seen.push({
            principal: mcpContext.getRequestPrincipal?.(),
            subject: mcpContext.getRequestSubject?.(),
            namespace: mcpContext.getRequestNamespace?.(),
          });
          return { content: [{ type: "text", text: "ok" }] };
        });
        return server;
      },
    });
    openTransports.push(transport);

    const subject = {
      id: "u:alice",
      context: "1to1" as const,
      hash: hashGatewaySubject("u:alice"),
    };
    const principal = { name: "plugin", admin: false, mayAssertSubject: true };
    const identity = "d".repeat(64);
    const post = (body: unknown, sessionId?: string) =>
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(sessionId
            ? {
                "mcp-session-id": sessionId,
                "mcp-protocol-version": "2025-11-25",
              }
            : {}),
        },
        body: JSON.stringify(body),
      });
    const context = (parsedBody: unknown) => ({
      identity,
      authenticated: true,
      principal,
      subject,
      parsedBody,
    });

    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "plugin", version: "1.0.0" },
      },
    };
    const initialized = await transport.handleRequest(
      post(init),
      context(init)
    );
    const sessionId = initialized.headers.get("mcp-session-id") ?? undefined;
    await initialized.text();
    const call = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    };
    const called = await transport.handleRequest(
      post(call, sessionId),
      context(call)
    );
    expect(called.status).toBe(200);
    await called.text();

    expect(seen).toEqual([
      {
        principal,
        subject,
        namespace: httpMcpRequestNamespace(
          `${identity}\u0000subject:${subject.hash}`
        ),
      },
    ]);
    const namespace = (seen[0] as { namespace: string }).namespace;
    expect(namespace).not.toBe(httpMcpRequestNamespace(identity));
    expect(namespace).not.toContain("alice");
  });
});
