/**
 * Show MCP server installation status across all targets.
 *
 * @module src/cli/commands/mcp/status
 */

import { getGlobals } from '../../program.js';
import {
  type AnyMcpConfig,
  getServerEntry,
  isYamlFormat,
  type OpenCodeMcpEntry,
  type StandardMcpEntry,
} from './config.js';
import {
  getTargetDisplayName,
  MCP_SERVER_NAME,
  MCP_TARGETS,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
  TARGETS_WITH_PROJECT_SCOPE,
} from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusOptions {
  target?: McpTarget | 'all';
  scope?: McpScope | 'all';
  /** Override cwd (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** JSON output */
  json?: boolean;
}

interface TargetStatus {
  target: McpTarget;
  scope: McpScope;
  configPath: string;
  configured: boolean;
  serverEntry?: { command: string; args: string[] };
  error?: string;
}

interface StatusResult {
  targets: TargetStatus[];
  summary: {
    configured: number;
    total: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize entry to standard format for display.
 */
function normalizeEntry(
  entry: StandardMcpEntry | OpenCodeMcpEntry
): StandardMcpEntry {
  if ('type' in entry && entry.type === 'local') {
    // OpenCode format: command is array [command, ...args]
    const [command = '', ...args] = entry.command;
    return { command, args };
  }
  return entry as StandardMcpEntry;
}

async function checkTargetStatus(
  target: McpTarget,
  scope: McpScope,
  options: { cwd?: string; homeDir?: string }
): Promise<TargetStatus> {
  const { cwd, homeDir } = options;

  const { configPath, configFormat } = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });

  const file = Bun.file(configPath);
  const exists = await file.exists();

  if (!exists) {
    return { target, scope, configPath, configured: false };
  }

  try {
    const content = await file.text();
    if (!content.trim()) {
      return { target, scope, configPath, configured: false };
    }

    const useYaml = isYamlFormat(configFormat);
    const config = useYaml
      ? (Bun.YAML.parse(content) as AnyMcpConfig)
      : (JSON.parse(content) as AnyMcpConfig);
    const entry = getServerEntry(config, MCP_SERVER_NAME, configFormat);

    if (entry) {
      const serverEntry = normalizeEntry(entry);
      return { target, scope, configPath, configured: true, serverEntry };
    }

    return { target, scope, configPath, configured: false };
  } catch {
    const format = isYamlFormat(configFormat) ? 'YAML' : 'JSON';
    return {
      target,
      scope,
      configPath,
      configured: false,
      error: `Malformed ${format}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get globals safely.
 */
function safeGetGlobals(): { json: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false };
  }
}

/**
 * Show MCP installation status.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: status display with multiple targets and scopes
export async function statusMcp(opts: StatusOptions = {}): Promise<void> {
  const targetFilter = opts.target ?? 'all';
  const scopeFilter = opts.scope ?? 'all';
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;

  const targets: McpTarget[] =
    targetFilter === 'all' ? MCP_TARGETS : [targetFilter];

  const results: TargetStatus[] = [];

  for (const target of targets) {
    const supportsProject = TARGETS_WITH_PROJECT_SCOPE.includes(target);

    if (supportsProject) {
      // Targets that support both scopes
      const scopes: McpScope[] =
        scopeFilter === 'all' ? ['user', 'project'] : [scopeFilter];

      for (const scope of scopes) {
        results.push(
          await checkTargetStatus(target, scope, {
            cwd: opts.cwd,
            homeDir: opts.homeDir,
          })
        );
      }
    } else if (scopeFilter === 'all' || scopeFilter === 'user') {
      // User scope only - skip if filtering by project
      results.push(
        await checkTargetStatus(target, 'user', {
          cwd: opts.cwd,
          homeDir: opts.homeDir,
        })
      );
    }
  }

  const configured = results.filter((r) => r.configured).length;
  const statusResult: StatusResult = {
    targets: results,
    summary: { configured, total: results.length },
  };

  // Output
  if (json) {
    process.stdout.write(`${JSON.stringify(statusResult, null, 2)}\n`);
    return;
  }

  // Terminal output
  process.stdout.write('MCP Server Status\n');
  process.stdout.write(`${'─'.repeat(50)}\n\n`);

  for (const status of results) {
    const targetName = getTargetDisplayName(status.target);
    const scopeLabel = status.scope === 'project' ? ' (project)' : '';
    const statusIcon = status.configured ? '✓' : '✗';
    const statusText = status.configured ? 'configured' : 'not configured';

    process.stdout.write(
      `${statusIcon} ${targetName}${scopeLabel}: ${statusText}\n`
    );

    if (status.configured && status.serverEntry) {
      process.stdout.write(`    Command: ${status.serverEntry.command}\n`);
      process.stdout.write(`    Args: ${status.serverEntry.args.join(' ')}\n`);
    }

    if (status.error) {
      process.stdout.write(`    Error: ${status.error}\n`);
    }

    process.stdout.write(`    Config: ${status.configPath}\n\n`);
  }

  process.stdout.write(`${configured}/${results.length} targets configured\n`);
}
