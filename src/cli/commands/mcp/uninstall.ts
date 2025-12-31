/**
 * Uninstall gno MCP server from client configurations.
 *
 * @module src/cli/commands/mcp/uninstall
 */

import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import {
  type AnyMcpConfig,
  isYamlFormat,
  readMcpConfig,
  removeServerEntry,
  writeMcpConfig,
} from './config.js';
import {
  getTargetDisplayName,
  MCP_SERVER_NAME,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
  TARGETS_WITH_PROJECT_SCOPE,
} from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface UninstallOptions {
  target?: McpTarget;
  scope?: McpScope;
  /** Override cwd (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** JSON output */
  json?: boolean;
  /** Quiet mode */
  quiet?: boolean;
}

interface UninstallResult {
  target: McpTarget;
  scope: McpScope;
  configPath: string;
  action: 'removed' | 'not_found';
}

// ─────────────────────────────────────────────────────────────────────────────
// Uninstall Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uninstall gno from a single target.
 */
async function uninstallFromTarget(
  target: McpTarget,
  scope: McpScope,
  options: { cwd?: string; homeDir?: string }
): Promise<UninstallResult> {
  const { cwd, homeDir } = options;

  const { configPath, configFormat } = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });

  const useYaml = isYamlFormat(configFormat);
  const config = await readMcpConfig(configPath, {
    returnNullOnMissing: true,
    yaml: useYaml,
  });

  // File doesn't exist
  if (config === null) {
    return { target, scope, configPath, action: 'not_found' };
  }

  // Try to remove entry using format-aware helper
  const removed = removeServerEntry(
    config as AnyMcpConfig,
    MCP_SERVER_NAME,
    configFormat
  );

  if (!removed) {
    return { target, scope, configPath, action: 'not_found' };
  }

  // Write back
  await writeMcpConfig(configPath, config as AnyMcpConfig, { yaml: useYaml });

  return { target, scope, configPath, action: 'removed' };
}

/**
 * Get globals safely.
 */
function safeGetGlobals(): { json: boolean; quiet: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false, quiet: false };
  }
}

/**
 * Uninstall gno MCP server.
 */
export async function uninstallMcp(opts: UninstallOptions = {}): Promise<void> {
  const target = opts.target ?? 'claude-desktop';
  const scope = opts.scope ?? 'user';
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;
  const quiet = opts.quiet ?? globals.quiet;

  // Validate scope - only some targets support project scope
  if (scope === 'project' && !TARGETS_WITH_PROJECT_SCOPE.includes(target)) {
    throw new CliError(
      'VALIDATION',
      `${getTargetDisplayName(target)} does not support project scope.`
    );
  }

  const result = await uninstallFromTarget(target, scope, {
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });

  // Output
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ uninstalled: result }, null, 2)}\n`
    );
    return;
  }

  if (quiet) {
    return;
  }

  if (result.action === 'not_found') {
    process.stdout.write(
      `gno is not configured in ${getTargetDisplayName(target)}.\n`
    );
    return;
  }

  process.stdout.write(
    `Removed gno MCP server from ${getTargetDisplayName(target)}.\n`
  );
  process.stdout.write(`  Config: ${result.configPath}\n\n`);
  process.stdout.write(
    `Restart ${getTargetDisplayName(target)} to apply changes.\n`
  );
}
