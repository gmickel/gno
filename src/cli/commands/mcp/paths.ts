/**
 * Path resolution for MCP server configuration.
 * Supports Claude Desktop, Claude Code, and Codex targets.
 *
 * @module src/cli/commands/mcp/paths
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type McpTarget = 'claude-desktop' | 'claude-code' | 'codex';
export type McpScope = 'user' | 'project';

export interface McpConfigPaths {
  /** Config file path */
  configPath: string;
  /** Whether this target supports project scope */
  supportsProjectScope: boolean;
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface McpPathOptions {
  target: McpTarget;
  scope?: McpScope;
  /** Override cwd for project scope (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_SERVER_NAME = 'gno';

/** All supported MCP targets */
export const MCP_TARGETS: McpTarget[] = [
  'claude-desktop',
  'claude-code',
  'codex',
];

/** Targets that support project scope */
export const TARGETS_WITH_PROJECT_SCOPE: McpTarget[] = ['claude-code', 'codex'];

/** Regex to extract entry script path from command path */
const COMMANDS_PATH_PATTERN = /\/commands\/.*$/;

// ─────────────────────────────────────────────────────────────────────────────
// Config Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve Claude Desktop config path based on platform.
 */
function resolveClaudeDesktopPath(home: string): string {
  const plat = platform();

  if (plat === 'darwin') {
    return join(
      home,
      'Library/Application Support/Claude/claude_desktop_config.json'
    );
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData/Roaming');
    return join(appData, 'Claude/claude_desktop_config.json');
  }
  // Linux and other Unix
  return join(home, '.config/Claude/claude_desktop_config.json');
}

/**
 * Resolve Claude Code config path.
 */
function resolveClaudeCodePath(
  scope: McpScope,
  home: string,
  cwd: string
): string {
  if (scope === 'user') {
    return join(home, '.claude.json');
  }
  return join(cwd, '.mcp.json');
}

/**
 * Resolve Codex config path.
 */
function resolveCodexPath(scope: McpScope, home: string, cwd: string): string {
  if (scope === 'user') {
    return join(home, '.codex.json');
  }
  return join(cwd, '.codex/.mcp.json');
}

/**
 * Resolve MCP config path for a given target and scope.
 */
export function resolveMcpConfigPath(opts: McpPathOptions): McpConfigPaths {
  const {
    target,
    scope = 'user',
    cwd = process.cwd(),
    homeDir = homedir(),
  } = opts;

  switch (target) {
    case 'claude-desktop':
      return {
        configPath: resolveClaudeDesktopPath(homeDir),
        supportsProjectScope: false,
      };
    case 'claude-code':
      return {
        configPath: resolveClaudeCodePath(scope, homeDir, cwd),
        supportsProjectScope: true,
      };
    case 'codex':
      return {
        configPath: resolveCodexPath(scope, homeDir, cwd),
        supportsProjectScope: true,
      };
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown target: ${_exhaustive}`);
    }
  }
}

/**
 * Resolve paths for all targets.
 */
export function resolveAllMcpPaths(
  scope: McpScope | 'all' = 'all',
  target: McpTarget | 'all' = 'all',
  overrides?: { cwd?: string; homeDir?: string }
): Array<{ target: McpTarget; scope: McpScope; paths: McpConfigPaths }> {
  const targets: McpTarget[] = target === 'all' ? MCP_TARGETS : [target];
  const results: Array<{
    target: McpTarget;
    scope: McpScope;
    paths: McpConfigPaths;
  }> = [];

  for (const t of targets) {
    if (t === 'claude-desktop') {
      // Claude Desktop only supports user scope - skip if filtering by project
      if (scope === 'project') {
        continue;
      }
      results.push({
        target: t,
        scope: 'user',
        paths: resolveMcpConfigPath({ target: t, scope: 'user', ...overrides }),
      });
    } else {
      // Other targets support both scopes
      const scopes: McpScope[] =
        scope === 'all' ? ['user', 'project'] : [scope];
      for (const s of scopes) {
        results.push({
          target: t,
          scope: s,
          paths: resolveMcpConfigPath({ target: t, scope: s, ...overrides }),
        });
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bun & GNO Path Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find absolute path to bun executable.
 * Cross-platform: uses process.execPath since we're already running under Bun.
 */
export function findBunPath(): string {
  // process.execPath is the absolute path to the Bun binary running this process.
  // This is cross-platform and doesn't require shelling out to `which`.
  return process.execPath;
}

/**
 * Detect how gno should be invoked and return the MCP server entry.
 * Uses absolute paths because Claude Desktop has a limited PATH.
 * Cross-platform: avoids shelling out to `which`.
 */
export function buildMcpServerEntry(): McpServerEntry {
  const bunPath = findBunPath();
  const home = homedir();
  const isWindows = platform() === 'win32';

  // 1. Check if running from source (dev mode)
  const scriptPath = process.argv[1];
  if (
    scriptPath?.includes('/gno/src/cli/') ||
    scriptPath?.includes('\\gno\\src\\cli\\')
  ) {
    // Dev mode: run the entry script directly with bun
    const entryScript = scriptPath.replace(COMMANDS_PATH_PATTERN, '/index.ts');
    return { command: bunPath, args: ['run', entryScript, 'mcp'] };
  }

  // 2. Check common gno install locations (cross-platform)
  const gnoCandidates = isWindows
    ? [
        join(home, '.bun\\bin\\gno.exe'),
        join(home, 'AppData\\Roaming\\npm\\gno.cmd'),
      ]
    : [
        join(home, '.bun/bin/gno'),
        '/usr/local/bin/gno',
        '/opt/homebrew/bin/gno',
      ];

  for (const gnoPath of gnoCandidates) {
    if (existsSync(gnoPath)) {
      return { command: bunPath, args: [gnoPath, 'mcp'] };
    }
  }

  // 3. Fallback to bunx (works if gno is published to npm)
  // Note: This may trigger network access on first run
  return { command: bunPath, args: ['x', 'gno', 'mcp'] };
}

/**
 * Get display name for a target.
 */
export function getTargetDisplayName(target: McpTarget): string {
  switch (target) {
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown target: ${_exhaustive}`);
    }
  }
}
