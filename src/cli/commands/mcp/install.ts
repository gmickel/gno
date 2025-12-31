/**
 * Install gno as MCP server in client configurations.
 *
 * @module src/cli/commands/mcp/install
 */

import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import { readMcpConfig, writeMcpConfig } from './config.js';
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
  action: 'created' | 'updated' | 'dry_run_create' | 'dry_run_update';
  serverEntry: { command: string; args: string[] };
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

  // Read existing config (needed for both dry-run preview and actual install)
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

  const wouldCreate = !existingEntry;

  if (dryRun) {
    return {
      target,
      scope,
      configPath,
      action: wouldCreate ? 'dry_run_create' : 'dry_run_update',
      serverEntry,
    };
  }

  const action = wouldCreate ? 'created' : 'updated';

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
    const dryRunVerb = result.action === 'dry_run_create' ? 'create' : 'update';
    process.stdout.write('Dry run - no changes made.\n\n');
    process.stdout.write(
      `Would ${dryRunVerb} gno in ${getTargetDisplayName(target)}:\n`
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
