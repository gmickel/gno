/**
 * MCP command - starts MCP server on stdio transport.
 *
 * @module src/cli/commands/mcp
 */

import type { GlobalOptions } from "../context";

/**
 * Start the MCP server.
 * Reads global options for --index and --config flags.
 */
export async function mcpCommand(
  options: GlobalOptions,
  commandOptions: { enableWrite?: boolean } = {}
): Promise<void> {
  const { startMcpServer } = await import("../../mcp/server.js");
  await startMcpServer({
    indexName: options.index,
    configPath: options.config,
    verbose: options.verbose,
    enableWrite: commandOptions.enableWrite,
  });
}
