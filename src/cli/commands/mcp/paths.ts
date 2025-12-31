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

export type McpTarget =
  | 'claude-desktop'
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'zed'
  | 'windsurf'
  | 'opencode'
  | 'amp'
  | 'lmstudio'
  | 'librechat';

export type McpScope = 'user' | 'project';

/**
 * Config format varies by target.
 * - standard: mcpServers key (Claude Desktop, Cursor, Windsurf, LM Studio)
 * - context_servers: Zed uses context_servers key
 * - mcp: OpenCode uses mcp key with array command
 * - amp_mcp: Amp uses amp.mcpServers key
 * - yaml_standard: YAML file with mcpServers key (LibreChat)
 */
export type McpConfigFormat =
  | 'standard'
  | 'context_servers'
  | 'mcp'
  | 'amp_mcp'
  | 'yaml_standard';

export interface McpConfigPaths {
  /** Config file path */
  configPath: string;
  /** Whether this target supports project scope */
  supportsProjectScope: boolean;
  /** Config format for this target */
  configFormat: McpConfigFormat;
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
  'cursor',
  'zed',
  'windsurf',
  'opencode',
  'amp',
  'lmstudio',
  'librechat',
];

/** Targets that support project scope */
export const TARGETS_WITH_PROJECT_SCOPE: McpTarget[] = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'librechat',
];

/** Get config format for a target */
export function getTargetConfigFormat(target: McpTarget): McpConfigFormat {
  switch (target) {
    case 'zed':
      return 'context_servers';
    case 'opencode':
      return 'mcp';
    case 'amp':
      return 'amp_mcp';
    case 'librechat':
      return 'yaml_standard';
    default:
      return 'standard';
  }
}

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
 * Resolve Cursor config path.
 */
function resolveCursorPath(scope: McpScope, home: string, cwd: string): string {
  if (scope === 'user') {
    const plat = platform();
    if (plat === 'win32') {
      return join(home, '.cursor', 'mcp.json');
    }
    return join(home, '.cursor/mcp.json');
  }
  return join(cwd, '.cursor/mcp.json');
}

/**
 * Resolve Zed config path (macOS/Linux only, no project scope).
 */
function resolveZedPath(home: string): string {
  const plat = platform();
  if (plat === 'win32') {
    // Zed not available on Windows, but provide path anyway
    return join(home, '.config/zed/settings.json');
  }
  // macOS and Linux use XDG or fallback
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return join(xdgConfig, 'zed/settings.json');
  }
  return join(home, '.config/zed/settings.json');
}

/**
 * Resolve Windsurf config path.
 */
function resolveWindsurfPath(home: string): string {
  const plat = platform();
  if (plat === 'win32') {
    return join(home, '.codeium', 'windsurf', 'mcp_config.json');
  }
  return join(home, '.codeium/windsurf/mcp_config.json');
}

/**
 * Resolve OpenCode config path.
 */
function resolveOpenCodePath(
  scope: McpScope,
  home: string,
  cwd: string
): string {
  if (scope === 'user') {
    const plat = platform();
    if (plat === 'win32') {
      return join(home, '.config', 'opencode', 'config.json');
    }
    return join(home, '.config/opencode/config.json');
  }
  // Project scope: opencode.json in project root
  return join(cwd, 'opencode.json');
}

/**
 * Resolve Amp config path.
 */
function resolveAmpPath(home: string): string {
  const plat = platform();
  if (plat === 'win32') {
    return join(home, '.config', 'amp', 'settings.json');
  }
  return join(home, '.config/amp/settings.json');
}

/**
 * Resolve LM Studio config path.
 */
function resolveLmStudioPath(home: string): string {
  const plat = platform();
  if (plat === 'win32') {
    return join(home, '.lmstudio', 'mcp.json');
  }
  return join(home, '.lmstudio/mcp.json');
}

/**
 * Resolve LibreChat config path.
 * LibreChat uses librechat.yaml in project root (project scope only).
 */
function resolveLibreChatPath(cwd: string): string {
  return join(cwd, 'librechat.yaml');
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

  const configFormat = getTargetConfigFormat(target);
  const supportsProjectScope = TARGETS_WITH_PROJECT_SCOPE.includes(target);

  switch (target) {
    case 'claude-desktop':
      return {
        configPath: resolveClaudeDesktopPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case 'claude-code':
      return {
        configPath: resolveClaudeCodePath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case 'codex':
      return {
        configPath: resolveCodexPath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case 'cursor':
      return {
        configPath: resolveCursorPath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case 'zed':
      return {
        configPath: resolveZedPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case 'windsurf':
      return {
        configPath: resolveWindsurfPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case 'opencode':
      return {
        configPath: resolveOpenCodePath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case 'amp':
      return {
        configPath: resolveAmpPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case 'lmstudio':
      return {
        configPath: resolveLmStudioPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case 'librechat':
      return {
        configPath: resolveLibreChatPath(cwd),
        supportsProjectScope,
        configFormat,
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
    const supportsProject = TARGETS_WITH_PROJECT_SCOPE.includes(t);

    if (supportsProject) {
      // Targets that support both scopes
      const scopes: McpScope[] =
        scope === 'all' ? ['user', 'project'] : [scope];
      for (const s of scopes) {
        results.push({
          target: t,
          scope: s,
          paths: resolveMcpConfigPath({ target: t, scope: s, ...overrides }),
        });
      }
    } else {
      // User scope only - skip if filtering by project
      if (scope === 'project') {
        continue;
      }
      results.push({
        target: t,
        scope: 'user',
        paths: resolveMcpConfigPath({ target: t, scope: 'user', ...overrides }),
      });
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
  return { command: bunPath, args: ['x', '@gmickel/gno', 'mcp'] };
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
    case 'cursor':
      return 'Cursor';
    case 'zed':
      return 'Zed';
    case 'windsurf':
      return 'Windsurf';
    case 'opencode':
      return 'OpenCode';
    case 'amp':
      return 'Amp';
    case 'lmstudio':
      return 'LM Studio';
    case 'librechat':
      return 'LibreChat';
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown target: ${_exhaustive}`);
    }
  }
}
