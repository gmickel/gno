/**
 * Install gno as MCP server in client configurations.
 * Atomic write via temp file + rename.
 *
 * @module src/cli/commands/mcp/install
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import {
  buildMcpServerEntry,
  getTargetDisplayName,
  MCP_SERVER_NAME,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  target?: McpTarget;
  scope?: McpScope;
  force?: boolean;
  dryRun?: boolean;
  /** Override cwd (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** JSON output */
  json?: boolean;
  /** Quiet mode */
  quiet?: boolean;
}

interface InstallResult {
  target: McpTarget;
  scope: McpScope;
  configPath: string;
  action: 'created' | 'updated' | 'already_exists' | 'dry_run';
  serverEntry: { command: string; args: string[] };
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
 * Returns empty config if file doesn't exist.
 * Throws on malformed JSON.
 */
async function readMcpConfig(configPath: string): Promise<McpConfig> {
  const file = Bun.file(configPath);
  const exists = await file.exists();

  if (!exists) {
    return {};
  }

  const content = await file.text();
  // Handle empty file
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
 * Write MCP config atomically via temp file + rename.
 * Creates backup of existing file first.
 */
async function writeMcpConfig(
  configPath: string,
  config: McpConfig
): Promise<void> {
  const dir = dirname(configPath);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  // Create backup of existing file
  try {
    const exists = await stat(configPath);
    if (exists.isFile()) {
      await copyFile(configPath, `${configPath}.bak`);
    }
  } catch {
    // File doesn't exist, no backup needed
  }

  // Write to temp file first
  const tmpPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
  try {
    await Bun.write(tmpPath, JSON.stringify(config, null, 2));
    // Atomic rename
    await rename(tmpPath, configPath);
  } catch (err) {
    // Cleanup temp file on error
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install gno to a single target.
 */
async function installToTarget(
  target: McpTarget,
  scope: McpScope,
  serverEntry: { command: string; args: string[] },
  options: {
    force?: boolean;
    dryRun?: boolean;
    cwd?: string;
    homeDir?: string;
  }
): Promise<InstallResult> {
  const { force = false, dryRun = false, cwd, homeDir } = options;

  const { configPath } = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });

  if (dryRun) {
    return {
      target,
      scope,
      configPath,
      action: 'dry_run',
      serverEntry,
    };
  }

  // Read existing config
  const config = await readMcpConfig(configPath);

  // Initialize mcpServers if needed
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Check if already exists
  const existingEntry = config.mcpServers[MCP_SERVER_NAME];
  if (existingEntry && !force) {
    throw new CliError(
      'VALIDATION',
      `${getTargetDisplayName(target)} already has gno configured.\n` +
        `  Config: ${configPath}\n` +
        '  Use --force to overwrite.'
    );
  }

  const action = existingEntry ? 'updated' : 'created';

  // Add/update entry
  config.mcpServers[MCP_SERVER_NAME] = serverEntry;

  // Write atomically
  await writeMcpConfig(configPath, config);

  return {
    target,
    scope,
    configPath,
    action,
    serverEntry,
  };
}

/**
 * Get globals safely for testing.
 */
function safeGetGlobals(): { json: boolean; quiet: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false, quiet: false };
  }
}

/**
 * Install gno MCP server.
 */
export async function installMcp(opts: InstallOptions = {}): Promise<void> {
  const target = opts.target ?? 'claude-desktop';
  const scope = opts.scope ?? 'user';
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;
  const quiet = opts.quiet ?? globals.quiet;

  // Validate scope for claude-desktop
  if (target === 'claude-desktop' && scope === 'project') {
    throw new CliError(
      'VALIDATION',
      'Claude Desktop does not support project scope. Use --scope user.'
    );
  }

  // Build server entry (uses process.execPath, always succeeds)
  const serverEntry = buildMcpServerEntry();

  // Install
  const result = await installToTarget(target, scope, serverEntry, {
    force,
    dryRun,
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });

  // Output
  if (json) {
    process.stdout.write(`${JSON.stringify({ installed: result }, null, 2)}\n`);
    return;
  }

  if (quiet) {
    return;
  }

  if (dryRun) {
    process.stdout.write('Dry run - no changes made.\n\n');
    process.stdout.write(
      `Would install gno to ${getTargetDisplayName(target)}:\n`
    );
    process.stdout.write(`  Config: ${result.configPath}\n`);
    process.stdout.write(`  Command: ${serverEntry.command}\n`);
    process.stdout.write(`  Args: ${serverEntry.args.join(' ')}\n`);
    return;
  }

  const verb = result.action === 'created' ? 'Installed' : 'Updated';
  process.stdout.write(
    `${verb} gno MCP server in ${getTargetDisplayName(target)}.\n`
  );
  process.stdout.write(`  Config: ${result.configPath}\n\n`);
  process.stdout.write(
    `Restart ${getTargetDisplayName(target)} to load the server.\n`
  );
}
