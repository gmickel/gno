/**
 * MCP 2026-07-28 dual-speak: wire-level negotiation assertions.
 *
 * A 2026-07-28 client negotiates natively (server/discover, sessionless
 * Streamable HTTP) over stdio and HTTP; a 2025-11-25 client is untouched
 * (test/mcp/legacy-parity.test.ts pins those bytes); a legacy initialize
 * never yields a 2026 negotiation; unsupported revisions, missing or
 * mismatched standard headers, and malformed envelopes are rejected with the
 * spec'd errors instead of being stripped or served.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer, SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { createMcpServerSurface } from "../../src/mcp/context";
import {
  isModernMcpRequest,
  MCP_SUPPORTED_PROTOCOL_REVISIONS,
} from "../../src/mcp/http-modern";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import {
  createLegacyParityToolContext,
  LEGACY_INITIALIZED_NOTIFICATION,
  LEGACY_PARITY_PROTOCOL_VERSION,
  LEGACY_PARITY_SERVER_IDENTITY,
  legacyInitializeRequest,
  legacyToolsListRequest,
} from "../fixtures/mcp/legacy-parity-context";
import {
  MODERN_PROTOCOL_VERSION,
  modernEnvelope,
  modernHeaders,
  modernRequest,
  spawnStdioWire,
} from "../helpers/mcp-wire";

const STDIO_SERVER_PATH = join(
  dirname(import.meta.dir),
  "fixtures",
  "mcp",
  "legacy-parity-server.ts"
);
const MCP_URL = "http://127.0.0.1:3210/mcp";
const UNSUPPORTED_PROTOCOL_VERSION = -32_022;
const HEADER_MISMATCH = -32_020;
const INVALID_PARAMS = -32_602;
const INVALID_REQUEST = -32_600;

interface JsonRpcError {
  error: { code: number; message: string; data?: unknown };
}
interface DiscoverEnvelope {
  result: { supportedVersions: string[]; _meta: Record<string, unknown> };
}

function createRuntime(): HttpMcpTransportRuntime {
  const mcpContext = createLegacyParityToolContext(false);
  // Egress lineage needs at least one collection to evaluate tools/call.
  const notes = {
    name: "notes",
    path: "/tmp/gno-protocol-2026/notes",
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  mcpContext.config.collections.push(notes);
  mcpContext.collections.push(notes);
  return {
    mcpContext,
    isShuttingDown: false,
    admitRequest: () => ({
      id: crypto.randomUUID(),
      signal: new AbortController().signal,
      finish: () => undefined,
    }),
    openSession: () => () => undefined,
  };
}

function post(body: unknown, headers: Record<string, string>): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const openTransports: HttpMcpTransport[] = [];
afterEach(async () => {
  await Promise.all(openTransports.splice(0).map((t) => t.close()));
});

describe("MCP 2026-07-28 negotiation over stdio", () => {
  test("a 2026-07-28 client negotiates natively and a later legacy initialize is refused", async () => {
    const wire = spawnStdioWire(STDIO_SERVER_PATH);
    try {
      wire.send(modernRequest(1, "server/discover"));
      const discover = await wire.next<DiscoverEnvelope>();
      expect(discover.result.supportedVersions).toEqual([
        MODERN_PROTOCOL_VERSION,
      ]);
      expect(discover.result._meta[SERVER_INFO_META_KEY]).toEqual(
        LEGACY_PARITY_SERVER_IDENTITY
      );
      expect(discover.result).not.toHaveProperty("protocolVersion");

      wire.send(modernRequest(2, "tools/list"));
      const tools = await wire.next<{
        result: { tools: unknown[]; _meta: Record<string, unknown> };
      }>();
      expect(tools.result.tools.length).toBeGreaterThan(0);
      expect(tools.result._meta[SERVER_INFO_META_KEY]).toEqual(
        LEGACY_PARITY_SERVER_IDENTITY
      );

      // The connection is pinned modern: a legacy initialize cannot re-open it.
      wire.send(legacyInitializeRequest(3));
      const refused = await wire.next<JsonRpcError>();
      expect(refused.error.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
      expect(refused.error.data).toEqual({
        supported: [MODERN_PROTOCOL_VERSION],
        requested: LEGACY_PARITY_PROTOCOL_VERSION,
      });
    } finally {
      await wire.close();
    }
  });

  test("a legacy initialize pins 2025-11-25 and never yields a 2026 negotiation", async () => {
    const wire = spawnStdioWire(STDIO_SERVER_PATH);
    try {
      wire.send({
        ...legacyInitializeRequest(1),
        params: {
          ...(legacyInitializeRequest(1).params as object),
          protocolVersion: MODERN_PROTOCOL_VERSION,
        },
      });
      const handshake = await wire.next<{
        result: { protocolVersion: string; supportedVersions?: unknown };
      }>();
      expect(handshake.result.protocolVersion).toBe(
        LEGACY_PARITY_PROTOCOL_VERSION
      );
      expect(handshake.result.supportedVersions).toBeUndefined();
      wire.send(LEGACY_INITIALIZED_NOTIFICATION);
      wire.send(legacyToolsListRequest(2));
      const tools = await wire.next<{ result: { _meta?: unknown } }>();
      // 2025-era responses carry no 2026 serverInfo stamp.
      expect(tools.result._meta).toBeUndefined();
    } finally {
      await wire.close();
    }
  });

  test("rejects unsupported revisions and malformed envelopes on stdio", async () => {
    const wire = spawnStdioWire(STDIO_SERVER_PATH);
    try {
      wire.send(
        modernRequest(
          1,
          "server/discover",
          {},
          modernEnvelope({
            "io.modelcontextprotocol/protocolVersion": "2027-01-01",
          })
        )
      );
      const unsupported = await wire.next<JsonRpcError>();
      expect(unsupported.error.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
      expect(unsupported.error.data).toEqual({
        supported: [MODERN_PROTOCOL_VERSION],
        requested: "2027-01-01",
      });

      wire.send(
        modernRequest(
          2,
          "server/discover",
          {},
          modernEnvelope({ "io.modelcontextprotocol/protocolVersion": 42 })
        )
      );
      const malformed = await wire.next<JsonRpcError>();
      expect(malformed.error.code).toBe(INVALID_PARAMS);
      expect(malformed.error.message).toContain("Invalid _meta envelope");
    } finally {
      await wire.close();
    }
  });
});

describe("MCP 2026-07-28 negotiation over Streamable HTTP", () => {
  function connectClient(
    transport: HttpMcpTransport,
    options: ConstructorParameters<typeof Client>[1],
    wire: Array<{ request: Request; body: string }>
  ): Promise<Client> {
    const client = new Client(
      { name: "era-client", version: "1.0.0" },
      options
    );
    const http = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (input, init) => {
        const request = new Request(input, init);
        wire.push({
          request,
          body: typeof init?.body === "string" ? init.body : "",
        });
        return transport.handleRequest(request);
      },
    });
    return client.connect(http).then(() => client);
  }

  test("real SDK clients land on their era through one endpoint", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: (ctx) =>
        createMcpServerSurface(ctx, LEGACY_PARITY_SERVER_IDENTITY),
    });
    openTransports.push(transport);

    const pinnedWire: Array<{ request: Request; body: string }> = [];
    const pinned = await connectClient(
      transport,
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
      pinnedWire
    );
    expect(pinned.getProtocolEra()).toBe("modern");
    expect(pinned.getServerVersion()).toEqual(LEGACY_PARITY_SERVER_IDENTITY);
    const probe = pinnedWire[0]!;
    expect(probe.body).toContain('"method":"server/discover"');
    expect(probe.request.headers.get("mcp-protocol-version")).toBe(
      MODERN_PROTOCOL_VERSION
    );
    expect(probe.request.headers.get("mcp-method")).toBe("server/discover");
    expect((await pinned.listTools()).tools.length).toBeGreaterThan(0);
    expect(transport.activeSessions).toBe(0);
    expect(pinnedWire.every((w) => !w.body.includes('"initialize"'))).toBe(
      true
    );

    const autoWire: Array<{ request: Request; body: string }> = [];
    const auto = await connectClient(
      transport,
      { versionNegotiation: { mode: "auto" } },
      autoWire
    );
    expect(auto.getProtocolEra()).toBe("modern");

    const legacyWire: Array<{ request: Request; body: string }> = [];
    const legacy = await connectClient(transport, {}, legacyWire);
    expect(legacy.getProtocolEra()).toBe("legacy");
    expect(legacy.getServerVersion()).toEqual(LEGACY_PARITY_SERVER_IDENTITY);
    expect(legacyWire[0]!.body).toContain('"method":"initialize"');
    expect(legacyWire.every((w) => !w.body.includes("server/discover"))).toBe(
      true
    );
    expect(transport.activeSessions).toBe(1);

    await Promise.all([pinned.close(), auto.close(), legacy.close()]);
  });

  test("a legacy initialize naming 2026-07-28 negotiates down, never up", async () => {
    const transport = new HttpMcpTransport(createRuntime());
    openTransports.push(transport);
    const response = await transport.handleRequest(
      post(
        {
          ...legacyInitializeRequest(1),
          params: {
            ...(legacyInitializeRequest(1).params as object),
            protocolVersion: MODERN_PROTOCOL_VERSION,
          },
        },
        {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        }
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const data = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("");
    const handshake = JSON.parse(data) as {
      result: { protocolVersion: string; supportedVersions?: unknown };
    };
    expect(handshake.result.protocolVersion).toBe(
      LEGACY_PARITY_PROTOCOL_VERSION
    );
    expect(handshake.result.supportedVersions).toBeUndefined();
  });

  const negativeCases: Array<{
    label: string;
    headers: Record<string, string>;
    body: unknown;
    code: number;
    fragment: string;
  }> = [
    {
      label: "unsupported revision",
      headers: {
        ...modernHeaders("tools/list"),
        "mcp-protocol-version": "2027-01-01",
      },
      body: modernRequest(
        1,
        "tools/list",
        {},
        modernEnvelope({
          "io.modelcontextprotocol/protocolVersion": "2027-01-01",
        })
      ),
      code: UNSUPPORTED_PROTOCOL_VERSION,
      fragment: "Unsupported protocol version: 2027-01-01",
    },
    {
      label: "missing MCP-Protocol-Version header",
      headers: (() => {
        const { "mcp-protocol-version": _omit, ...rest } =
          modernHeaders("tools/list");
        return rest;
      })(),
      body: modernRequest(1, "tools/list"),
      code: HEADER_MISMATCH,
      fragment: "MCP-Protocol-Version header is absent",
    },
    {
      label: "MCP-Protocol-Version header disagrees with the envelope",
      headers: {
        ...modernHeaders("tools/list"),
        "mcp-protocol-version": "2025-11-25",
      },
      body: modernRequest(1, "tools/list"),
      code: HEADER_MISMATCH,
      fragment: "MCP-Protocol-Version header names 2025-11-25",
    },
    {
      label: "MCP-Protocol-Version header without an envelope",
      headers: modernHeaders("tools/list"),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      code: INVALID_PARAMS,
      fragment: "missing the required per-request envelope",
    },
    {
      label: "missing Mcp-Method header",
      headers: (() => {
        const { "mcp-method": _omit, ...rest } = modernHeaders("tools/list");
        return rest;
      })(),
      body: modernRequest(1, "tools/list"),
      code: HEADER_MISMATCH,
      fragment: "Mcp-Method header is absent",
    },
    {
      label: "Mcp-Method header disagrees with the body",
      headers: modernHeaders("tools/call"),
      body: modernRequest(1, "tools/list"),
      code: HEADER_MISMATCH,
      fragment: "Mcp-Method header names tools/call",
    },
    {
      label: "missing Mcp-Name header on tools/call",
      headers: modernHeaders("tools/call"),
      body: modernRequest(1, "tools/call", {
        name: "gno_status",
        arguments: {},
      }),
      code: HEADER_MISMATCH,
      fragment: "Mcp-Name header is absent",
    },
    {
      label: "Mcp-Name header disagrees with params.name",
      headers: modernHeaders("tools/call", "gno_search"),
      body: modernRequest(1, "tools/call", {
        name: "gno_status",
        arguments: {},
      }),
      code: HEADER_MISMATCH,
      fragment: 'Mcp-Name header names "gno_search"',
    },
    {
      label: "malformed protocolVersion claim",
      headers: modernHeaders("tools/list"),
      body: modernRequest(
        1,
        "tools/list",
        {},
        modernEnvelope({ "io.modelcontextprotocol/protocolVersion": 42 })
      ),
      code: INVALID_PARAMS,
      fragment: "io.modelcontextprotocol/protocolVersion",
    },
    {
      label: "malformed clientInfo",
      headers: modernHeaders("tools/list"),
      body: modernRequest(
        1,
        "tools/list",
        {},
        modernEnvelope({ "io.modelcontextprotocol/clientInfo": "nope" })
      ),
      code: INVALID_PARAMS,
      fragment: "io.modelcontextprotocol/clientInfo",
    },
    {
      label: "Mcp-Session-Id on a 2026 request",
      headers: {
        ...modernHeaders("tools/list"),
        "mcp-session-id": "legacy-session",
      },
      body: modernRequest(1, "tools/list"),
      code: INVALID_REQUEST,
      fragment: "Mcp-Session-Id is not valid",
    },
    {
      label: "JSON-RPC batch of 2026 requests",
      headers: modernHeaders("tools/list"),
      body: [modernRequest(1, "tools/list")],
      code: INVALID_REQUEST,
      fragment:
        "batches may not contain requests for protocol revision 2026-07-28",
    },
  ];

  test.each(negativeCases)(
    "rejects $label with the spec'd error",
    async ({ headers, body, code, fragment }) => {
      const transport = new HttpMcpTransport(createRuntime());
      openTransports.push(transport);
      const response = await transport.handleRequest(post(body, headers));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as JsonRpcError;
      expect(payload.error.code).toBe(code);
      expect(payload.error.message).toContain(fragment);
      expect(transport.activeSessions).toBe(0);
      expect(transport.activeRequests).toBe(0);
    }
  );

  test("preserves custom _meta and routing headers end-to-end", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: () => {
        const server = new McpServer({ name: "meta-echo", version: "1" });
        server.registerTool(
          "echo_meta",
          { inputSchema: z.object({}) },
          async (_args, ctx) => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  meta: ctx.mcpReq._meta,
                  envelope: ctx.mcpReq.envelope,
                }),
              },
            ],
          })
        );
        return server;
      },
    });
    openTransports.push(transport);
    const response = await transport.handleRequest(
      post(
        modernRequest(
          7,
          "tools/call",
          { name: "echo_meta", arguments: {} },
          modernEnvelope({ "com.example/trace": "trace-123" })
        ),
        modernHeaders("tools/call", "echo_meta")
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const payload = (await response.json()) as {
      id: number;
      result: {
        content: Array<{ text: string }>;
        _meta: Record<string, unknown>;
      };
    };
    expect(payload.id).toBe(7);
    const echoed = JSON.parse(payload.result.content[0]!.text) as {
      meta: Record<string, unknown>;
      envelope: Record<string, unknown>;
    };
    expect(echoed.meta).toEqual({ "com.example/trace": "trace-123" });
    expect(echoed.envelope["io.modelcontextprotocol/protocolVersion"]).toBe(
      MODERN_PROTOCOL_VERSION
    );
    expect(payload.result._meta[SERVER_INFO_META_KEY]).toEqual({
      name: "meta-echo",
      version: "1",
    });
  });
});

describe("MCP-Protocol-Version header classification is an explicit revision set", () => {
  const legacyBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
  const withHeader = (value: string): Request =>
    post(legacyBody, {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": value,
    });

  test("GNO speaks exactly the two documented revisions", () => {
    expect([...MCP_SUPPORTED_PROTOCOL_REVISIONS].sort()).toEqual([
      LEGACY_PARITY_PROTOCOL_VERSION,
      MODERN_PROTOCOL_VERSION,
    ]);
  });

  test("only the modern member classifies as modern; sorting-adjacent labels do not", async () => {
    expect(
      await isModernMcpRequest(withHeader(MODERN_PROTOCOL_VERSION), legacyBody)
    ).toBe(true);
    for (const label of [
      "abc",
      "zzzz",
      "2027-01-01",
      "2026-07-280",
      LEGACY_PARITY_PROTOCOL_VERSION,
    ]) {
      expect(await isModernMcpRequest(withHeader(label), legacyBody)).toBe(
        false
      );
    }
  });

  test("a non-date label like `abc` is rejected on the wire, never served", async () => {
    const transport = new HttpMcpTransport(createRuntime(), {
      createServer: (context) =>
        createMcpServerSurface(context, LEGACY_PARITY_SERVER_IDENTITY),
    });
    openTransports.push(transport);
    const response = await transport.handleRequest(withHeader("abc"));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as JsonRpcError & {
      result?: unknown;
    };
    expect(payload.result).toBeUndefined();
    expect(payload.error.code).toBe(-32_000);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(transport.activeSessions).toBe(0);
  });
});
