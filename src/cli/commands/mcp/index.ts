/**
 * MCP command exports.
 *
 * @module src/cli/commands/mcp
 */

export { type InstallOptions, installMcp } from './install.js';
export {
  buildMcpServerEntry,
  findBunPath,
  getTargetDisplayName,
  MCP_SERVER_NAME,
  MCP_TARGETS,
  type McpConfigPaths,
  type McpPathOptions,
  type McpScope,
  type McpServerEntry,
  type McpTarget,
  resolveAllMcpPaths,
  resolveMcpConfigPath,
  TARGETS_WITH_PROJECT_SCOPE,
} from './paths.js';
export { type StatusOptions, statusMcp } from './status.js';
export { type UninstallOptions, uninstallMcp } from './uninstall.js';
