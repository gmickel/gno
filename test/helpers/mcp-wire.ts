/** Hand-rolled MCP wire helpers: newline-delimited stdio and 2026-07-28 envelopes. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MODERN_WIRE_CLIENT_INFO = {
  name: "modern-wire-client",
  version: "1.0.0",
} as const;
const STDIO_LINE_TIMEOUT_MS = 30_000;

/** A well-formed 2026-07-28 per-request `_meta` envelope. */
export function modernEnvelope(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: MODERN_WIRE_CLIENT_INFO,
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

export function modernRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown> = {},
  envelope: Record<string, unknown> = modernEnvelope()
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope } };
}

/** The SEP-2243 standard headers a modern request POST carries. */
export function modernHeaders(
  method: string,
  name?: string
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
    ...(name === undefined ? {} : { "mcp-name": name }),
  };
}

export class StdioLineReader {
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

export interface StdioWire {
  send(message: unknown): void;
  next<T = Record<string, unknown>>(): Promise<T>;
  close(): Promise<void>;
}

/** Spawn a stdio MCP server script and speak raw JSON-RPC lines to it. */
export function spawnStdioWire(
  scriptPath: string,
  env: Record<string, string> = {}
): StdioWire {
  const child = Bun.spawn([process.execPath, scriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const lines = new StdioLineReader(child.stdout);
  return {
    send(message) {
      void child.stdin.write(`${JSON.stringify(message)}\n`);
      void child.stdin.flush();
    },
    async next<T>() {
      return JSON.parse(await lines.next()) as T;
    },
    async close() {
      void child.stdin.end();
      await child.exited;
    },
  };
}
