/**
 * MCP command - starts MCP server on stdio transport.
 *
 * @module src/cli/commands/mcp
 */

import type { McpToolProfile } from "../../mcp/tool-profile";
import type { GlobalOptions } from "../context";

import { warnIfBunBelowFloor } from "../../app/bun-runtime";

/**
 * Start the MCP server.
 * Reads global options for --index and --config flags.
 */
export async function mcpCommand(
  options: GlobalOptions,
  commandOptions: { enableWrite?: boolean; toolProfile?: McpToolProfile } = {}
): Promise<void> {
  // stderr only: stdout carries the MCP protocol.
  warnIfBunBelowFloor("mcp");
  const { startMcpServer } = await import("../../mcp/server.js");
  await startMcpServer({
    indexName: options.index,
    configPath: options.config,
    verbose: options.verbose,
    enableWrite: commandOptions.enableWrite,
    toolProfile: commandOptions.toolProfile,
  });
}
