/**
 * MCP legacy (2025-11-25) wire parity golden.
 *
 * Captures the raw initialize handshake and tools/list bytes a 2025-11-25
 * client observes over stdio and Streamable HTTP, for the read set and the
 * --enable-write set, and pins them to test/fixtures/mcp/legacy-2025-11-25.json.
 *
 * Regenerate deliberately with:
 *   GNO_UPDATE_MCP_GOLDEN=1 bun test test/mcp/legacy-parity.test.ts
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
    child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.flush();
  };
  try {
    send(legacyInitializeRequest(1));
    const initialize = await lines.next();
    send(LEGACY_INITIALIZED_NOTIFICATION);
    send(legacyToolsListRequest(2));
    const toolsList = await lines.next();
    return { initialize, toolsList };
  } finally {
    child.stdin.end();
    await child.exited;
  }
}

function httpRequest(
  body: unknown,
  sessionId?: string,
  signal?: AbortSignal
): Request {
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
    signal,
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

function parseJsonRpc(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function parseSseData(body: string): Record<string, unknown> {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return JSON.parse(data) as Record<string, unknown>;
}

describe("MCP legacy 2025-11-25 wire parity", () => {
  test("stdio and Streamable HTTP bytes match the committed golden", async () => {
    const actual = await captureLegacyWire();
    const goldenFile = Bun.file(GOLDEN_PATH);

    if (UPDATE_GOLDEN || !(await goldenFile.exists())) {
      await Bun.write(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
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
    const handshake = parseJsonRpc(actual.stdio.read.initialize) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(handshake.result.protocolVersion).toBe(
      LEGACY_PARITY_PROTOCOL_VERSION
    );
    expect(handshake.result.serverInfo.name).toBe(
      LEGACY_PARITY_SERVER_IDENTITY.name
    );
    const readTools = (
      parseJsonRpc(actual.stdio.read.toolsList) as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools;
    const writeTools = (
      parseJsonRpc(actual.stdio.write.toolsList) as {
        result: { tools: Array<{ name: string }> };
      }
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
});
