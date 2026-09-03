/** Dual-era stdio serving entry shared by `gno mcp` and the wire fixtures. */

import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";

import type { ToolContext } from "./context";

import { createMcpServerSurface } from "./context";

export interface McpStdioServerIdentity {
  readonly name: string;
  readonly version: string;
}

export interface ServeMcpStdioOptions {
  /** Defaults to the current process's stdio. */
  transport?: ServeStdioOptions["transport"];
  onerror?: (error: Error) => void;
}

/**
 * Serve the GNO MCP surface over stdio for both protocol eras.
 *
 * The opening exchange pins the connection's era: a 2025-era `initialize`
 * is served exactly as the hand-wired stdio server served it (the legacy
 * parity golden pins those bytes); a 2026-07-28 `server/discover` opening
 * negotiates natively. The factory builds a fresh surface per instance
 * because the entry may construct one for a discarded probe before the
 * pinned instance.
 */
export function serveMcpStdio(
  context: ToolContext,
  identity: McpStdioServerIdentity,
  options: ServeMcpStdioOptions = {}
): StdioServerHandle {
  return serveStdio(() => createMcpServerSurface(context, identity), {
    legacy: "serve",
    transport: options.transport ?? new StdioServerTransport(),
    onerror: options.onerror,
  });
}
