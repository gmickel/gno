/**
 * Uninstall gno MCP server from client configurations.
 *
 * @module src/cli/commands/mcp/uninstall
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import {
  getTargetDisplayName,
  MCP_SERVER_NAME,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
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
// Config File Operations
// ─────────────────────────────────────────────────────────────────────────────

interface McpConfig {
  mcpServers?: Record<string, { command: string; args: string[] }>;
  [key: string]: unknown;
}

/**
 * Read and parse MCP config file.
 */
async function readMcpConfig(configPath: string): Promise<McpConfig | null> {
  const file = Bun.file(configPath);
  const exists = await file.exists();

  if (!exists) {
    return null;
  }

  const content = await file.text();
  if (!content.trim()) {
    return {};
  }

  try {
    return JSON.parse(content) as McpConfig;
  } catch {
    throw new CliError(
      'RUNTIME',
      `Malformed JSON in ${configPath}. Please fix or backup and delete the file.`
    );
  }
}

/**
 * Write MCP config atomically.
 */
async function writeMcpConfig(
  configPath: string,
  config: McpConfig
): Promise<void> {
  const dir = dirname(configPath);
  await mkdir(dir, { recursive: true });

  // Backup
  try {
    const exists = await stat(configPath);
    if (exists.isFile()) {
      await copyFile(configPath, `${configPath}.bak`);
    }
  } catch {
    // No backup needed
  }

  const tmpPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
  try {
    await Bun.write(tmpPath, JSON.stringify(config, null, 2));
    await rename(tmpPath, configPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore
    }
    throw err;
  }
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

  const { configPath } = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });

  const config = await readMcpConfig(configPath);

  // File doesn't exist
  if (config === null) {
    return { target, scope, configPath, action: 'not_found' };
  }

  // No mcpServers section or no gno entry
  if (!config.mcpServers?.[MCP_SERVER_NAME]) {
    return { target, scope, configPath, action: 'not_found' };
  }

  // Remove entry
  delete config.mcpServers[MCP_SERVER_NAME];

  // Clean up empty mcpServers object
  if (Object.keys(config.mcpServers).length === 0) {
    config.mcpServers = undefined;
  }

  // Write back
  await writeMcpConfig(configPath, config);

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

  // Validate scope for claude-desktop
  if (target === 'claude-desktop' && scope === 'project') {
    throw new CliError(
      'VALIDATION',
      'Claude Desktop does not support project scope.'
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
