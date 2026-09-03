/**
 * MCP legacy (2025-11-25) wire parity golden.
 *
 * Captures the raw initialize handshake and tools/list bytes a 2025-11-25
 * client observes over stdio and Streamable HTTP, for the read set and the
 * --enable-write set, and pins them two ways:
 *
 * 1. Byte-exact against test/fixtures/mcp/legacy-2025-11-25.json (the current
 *    SDK's wire). A missing golden FAILS the test; it is never regenerated
 *    silently. Regenerate (or create) deliberately with:
 *      GNO_UPDATE_MCP_GOLDEN=1 bun test test/mcp/legacy-parity.test.ts
 *    and review the fixture diff before committing it.
 * 2. Against the frozen pre-migration capture
 *    test/fixtures/mcp/legacy-2025-11-25.sdk-v1.30.0.json, taken on
 *    @modelcontextprotocol/sdk 1.30.0 and never regenerated. The handshake
 *    must match byte-for-byte; tools/list must match after removing only the
 *    two SDK-owned deltas of the v1 -> v2 migration:
 *      - the JSON Schema dialect stamp (`$schema`: draft-07 -> 2020-12, and
 *        its key position), which the SDK generates from the same zod
 *        schemas;
 *      - the removed experimental `execution.taskSupport` member (the SDK
 *        dropped the 2025-11 experimental tasks feature, SEP-2663);
 *      - the two discriminated-union inputs (`gno_rename_note`,
 *        `gno_move_note`), which SDK v1 flattened to an empty
 *        `{ "type": "object", "properties": {} }` placeholder and SDK v2
 *        advertises as the real `oneOf` schema. The zod sources are unchanged.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";

import { createMcpServerSurface } from "../../src/mcp/context";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import {
  createLegacyParityToolContext,
  LEGACY_INITIALIZED_NOTIFICATION,
  LEGACY_PARITY_ENABLE_WRITE_ENV,
  LEGACY_PARITY_PROTOCOL_VERSION,
  LEGACY_PARITY_SERVER_IDENTITY,
  legacyInitializeRequest,
  legacyToolsListRequest,
} from "../fixtures/mcp/legacy-parity-context";

const FIXTURE_DIR = join(dirname(import.meta.dir), "fixtures", "mcp");
const GOLDEN_PATH = join(FIXTURE_DIR, "legacy-2025-11-25.json");
const SDK_V1_REFERENCE_PATH = join(
  FIXTURE_DIR,
  "legacy-2025-11-25.sdk-v1.30.0.json"
);
const STDIO_SERVER_PATH = join(FIXTURE_DIR, "legacy-parity-server.ts");
const UPDATE_GOLDEN = process.env.GNO_UPDATE_MCP_GOLDEN === "1";
const MCP_URL = "http://127.0.0.1:3210/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
const STDIO_LINE_TIMEOUT_MS = 30_000;

interface HttpWireResponse {
  status: number;
  contentType: string | null;
  body: string;
}

interface StdioWireCapture {
  initialize: string;
  toolsList: string;
}

interface HttpWireCapture {
  initialize: HttpWireResponse;
  initialized: HttpWireResponse;
  toolsList: HttpWireResponse;
}

interface LegacyWireGolden {
  protocolVersion: string;
  stdio: { read: StdioWireCapture; write: StdioWireCapture };
  http: { read: HttpWireCapture; write: HttpWireCapture };
}

interface WireTool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: unknown;
  [key: string]: unknown;
}

interface ToolsListEnvelope {
  result: { tools: WireTool[] };
}

class LineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<string> {
    const deadline = Date.now() + STDIO_LINE_TIMEOUT_MS;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for a stdio JSON-RPC line");
      }
      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("stdio server closed before responding");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function captureStdio(enableWrite: boolean): Promise<StdioWireCapture> {
  const child = Bun.spawn([process.execPath, STDIO_SERVER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      [LEGACY_PARITY_ENABLE_WRITE_ENV]: enableWrite ? "1" : "0",
    },
  });
  const lines = new LineReader(child.stdout);
  const send = (message: unknown): void => {
    void child.stdin.write(`${JSON.stringify(message)}\n`);
    void child.stdin.flush();
  };
  try {
    send(legacyInitializeRequest(1));
    const initialize = await lines.next();
    send(LEGACY_INITIALIZED_NOTIFICATION);
    send(legacyToolsListRequest(2));
    const toolsList = await lines.next();
    return { initialize, toolsList };
  } finally {
    void child.stdin.end();
    await child.exited;
  }
}

function httpRequest(body: unknown, sessionId?: string): Request {
  const headers = new Headers({
    accept: MCP_ACCEPT,
    "content-type": "application/json",
  });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", LEGACY_PARITY_PROTOCOL_VERSION);
  }
  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function toWire(response: Response): Promise<HttpWireResponse> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

async function captureHttp(enableWrite: boolean): Promise<HttpWireCapture> {
  const context = createLegacyParityToolContext(enableWrite);
  const runtime: HttpMcpTransportRuntime = {
    mcpContext: context,
    isShuttingDown: false,
    admitRequest: () => ({
      id: crypto.randomUUID(),
      signal: new AbortController().signal,
      finish: () => undefined,
    }),
    openSession: () => () => undefined,
  };
  const transport = new HttpMcpTransport(runtime, {
    enableWrite,
    createServer: (ctx) =>
      createMcpServerSurface(ctx, LEGACY_PARITY_SERVER_IDENTITY),
  });
  try {
    const initializeResponse = await transport.handleRequest(
      httpRequest(legacyInitializeRequest(1))
    );
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const initialize = await toWire(initializeResponse);
    const initialized = await toWire(
      await transport.handleRequest(
        httpRequest(LEGACY_INITIALIZED_NOTIFICATION, sessionId!)
      )
    );
    const toolsList = await toWire(
      await transport.handleRequest(
        httpRequest(legacyToolsListRequest(2), sessionId!)
      )
    );
    return { initialize, initialized, toolsList };
  } finally {
    await transport.close();
  }
}

async function captureLegacyWire(): Promise<LegacyWireGolden> {
  return {
    protocolVersion: LEGACY_PARITY_PROTOCOL_VERSION,
    stdio: {
      read: await captureStdio(false),
      write: await captureStdio(true),
    },
    http: {
      read: await captureHttp(false),
      write: await captureHttp(true),
    },
  };
}

function parseJsonRpc<T = Record<string, unknown>>(line: string): T {
  return JSON.parse(line) as T;
}

function parseSseData<T = Record<string, unknown>>(body: string): T {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return JSON.parse(data) as T;
}

/** Tools whose union input SDK v1 could only advertise as a placeholder. */
const SDK_V1_UNION_PLACEHOLDER_TOOLS = new Set([
  "gno_rename_note",
  "gno_move_note",
]);
const SDK_V1_UNION_PLACEHOLDER = { type: "object", properties: {} };
const SDK_V1_DIALECT = "http://json-schema.org/draft-07/schema#";
const SDK_V2_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Strip exactly the SDK-owned v1 -> v2 deltas; everything else must match. */
function withoutSdkDeltas(schema: Record<string, unknown>): unknown {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

function normalizeToolsList(line: string): string {
  const envelope = parseJsonRpc<ToolsListEnvelope>(line);
  const tools = envelope.result.tools.map((tool) => {
    const { execution: _execution, inputSchema, outputSchema, ...rest } = tool;
    return {
      ...rest,
      inputSchema: SDK_V1_UNION_PLACEHOLDER_TOOLS.has(tool.name)
        ? "<sdk-v1 union placeholder>"
        : withoutSdkDeltas(inputSchema),
      ...(outputSchema ? { outputSchema: withoutSdkDeltas(outputSchema) } : {}),
    };
  });
  return JSON.stringify({ ...envelope, result: { tools } });
}

describe("MCP legacy 2025-11-25 wire parity", () => {
  test("stdio and Streamable HTTP bytes match the committed golden", async () => {
    const actual = await captureLegacyWire();
    const goldenFile = Bun.file(GOLDEN_PATH);

    if (UPDATE_GOLDEN) {
      await Bun.write(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    } else if (!(await goldenFile.exists())) {
      throw new Error(
        `Missing MCP legacy golden ${GOLDEN_PATH}; regenerate deliberately with GNO_UPDATE_MCP_GOLDEN=1`
      );
    }
    const golden = (await Bun.file(GOLDEN_PATH).json()) as LegacyWireGolden;

    expect(golden.protocolVersion).toBe(LEGACY_PARITY_PROTOCOL_VERSION);
    expect(actual.stdio.read.initialize).toBe(golden.stdio.read.initialize);
    expect(actual.stdio.read.toolsList).toBe(golden.stdio.read.toolsList);
    expect(actual.stdio.write.initialize).toBe(golden.stdio.write.initialize);
    expect(actual.stdio.write.toolsList).toBe(golden.stdio.write.toolsList);
    expect(actual.http.read).toEqual(golden.http.read);
    expect(actual.http.write).toEqual(golden.http.write);

    // The captured shapes are sane, not merely self-consistent.
    const handshake = parseJsonRpc<{
      result: { protocolVersion: string; serverInfo: { name: string } };
    }>(actual.stdio.read.initialize);
    expect(handshake.result.protocolVersion).toBe(
      LEGACY_PARITY_PROTOCOL_VERSION
    );
    expect(handshake.result.serverInfo.name).toBe(
      LEGACY_PARITY_SERVER_IDENTITY.name
    );
    const readTools = parseJsonRpc<ToolsListEnvelope>(
      actual.stdio.read.toolsList
    ).result.tools;
    const writeTools = parseJsonRpc<ToolsListEnvelope>(
      actual.stdio.write.toolsList
    ).result.tools;
    expect(readTools.length).toBeGreaterThan(0);
    expect(writeTools.length).toBeGreaterThan(readTools.length);
    expect(parseSseData(actual.http.read.toolsList.body)).toEqual(
      parseJsonRpc(actual.stdio.read.toolsList)
    );
    expect(parseSseData(actual.http.write.toolsList.body)).toEqual(
      parseJsonRpc(actual.stdio.write.toolsList)
    );
  });

  test("matches the frozen SDK v1.30.0 capture modulo the documented SDK deltas", async () => {
    const actual = await captureLegacyWire();
    const reference = (await Bun.file(
      SDK_V1_REFERENCE_PATH
    ).json()) as LegacyWireGolden;

    // Handshake: byte-identical on both transports.
    expect(actual.stdio.read.initialize).toBe(reference.stdio.read.initialize);
    expect(actual.stdio.write.initialize).toBe(
      reference.stdio.write.initialize
    );
    expect(actual.http.read.initialize).toEqual(reference.http.read.initialize);
    expect(actual.http.write.initialize).toEqual(
      reference.http.write.initialize
    );
    expect(actual.http.read.initialized).toEqual(
      reference.http.read.initialized
    );
    expect(actual.http.write.initialized).toEqual(
      reference.http.write.initialized
    );

    // tools/list: identical names, order, descriptions, annotations, and
    // schemas (including key order) once the two SDK-owned deltas are removed.
    for (const profile of ["read", "write"] as const) {
      expect(normalizeToolsList(actual.stdio[profile].toolsList)).toBe(
        normalizeToolsList(reference.stdio[profile].toolsList)
      );
      expect(actual.http[profile].toolsList.status).toBe(
        reference.http[profile].toolsList.status
      );
      expect(actual.http[profile].toolsList.contentType).toBe(
        reference.http[profile].toolsList.contentType
      );
      expect(
        normalizeToolsList(
          JSON.stringify(parseSseData(actual.http[profile].toolsList.body))
        )
      ).toBe(
        normalizeToolsList(
          JSON.stringify(parseSseData(reference.http[profile].toolsList.body))
        )
      );
    }

    // The deltas are exactly the documented ones, so the reference cannot
    // silently drift into "anything goes": the v1 capture carried the
    // draft-07 stamp and the experimental execution member on every tool, and
    // the placeholder on exactly the two union-input tools.
    const referenceTools = parseJsonRpc<ToolsListEnvelope>(
      reference.stdio.write.toolsList
    ).result.tools;
    const actualTools = parseJsonRpc<ToolsListEnvelope>(
      actual.stdio.write.toolsList
    ).result.tools;
    const referencePlaceholders = referenceTools
      .filter((tool) => tool.inputSchema.$schema === undefined)
      .map((tool) => tool.name);
    expect(new Set(referencePlaceholders)).toEqual(
      SDK_V1_UNION_PLACEHOLDER_TOOLS
    );
    for (const tool of referenceTools) {
      if (SDK_V1_UNION_PLACEHOLDER_TOOLS.has(tool.name)) {
        expect(tool.inputSchema).toEqual(SDK_V1_UNION_PLACEHOLDER);
      } else {
        expect(tool.inputSchema.$schema).toBe(SDK_V1_DIALECT);
      }
      expect(tool.execution).toEqual({ taskSupport: "forbidden" });
    }
    for (const tool of actualTools) {
      expect(tool.inputSchema.$schema).toBe(SDK_V2_DIALECT);
      expect(tool.execution).toBeUndefined();
      if (SDK_V1_UNION_PLACEHOLDER_TOOLS.has(tool.name)) {
        expect(tool.inputSchema.type).toBe("object");
        expect(Array.isArray(tool.inputSchema.oneOf)).toBe(true);
      }
    }
  });
});
