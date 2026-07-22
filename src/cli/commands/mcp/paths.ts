/**
 * Path resolution for MCP server configuration.
 * Supports Claude Desktop, Claude Code, and Codex targets.
 *
 * @module src/cli/commands/mcp/paths
 */

import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import type { ConnectorWorkspaceEnvironment } from "../../../core/connector-environment";

import { resolveDirs } from "../../../app/constants";
import { assertValidIndexName } from "../../../app/index-name";
import { getCurrentGnoEntrypoint } from "../../../core/runtime-entrypoint";
import { getTargetDisplayName } from "./target-display.js";

export { getTargetDisplayName } from "./target-display.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type McpTarget =
  | "claude-desktop"
  | "claude-code"
  | "codex"
  | "cursor"
  | "zed"
  | "windsurf"
  | "opencode"
  | "amp"
  | "lmstudio"
  | "librechat";

export type McpScope = "user" | "project";

/**
 * Config format varies by target.
 * - standard: mcpServers key (Claude Desktop, Cursor, Windsurf, LM Studio)
 * - context_servers: Zed uses context_servers key
 * - mcp: OpenCode uses mcp key with array command
 * - amp_mcp: Amp uses amp.mcpServers key
 * - yaml_standard: YAML file with mcpServers key (LibreChat)
 */
export type McpConfigFormat =
  | "standard"
  | "context_servers"
  | "mcp"
  | "amp_mcp"
  | "yaml_standard"
  | "codex_toml";

export interface McpConfigPaths {
  /** Config file path */
  configPath: string;
  /** Whether this target supports project scope */
  supportsProjectScope: boolean;
  /** Config format for this target */
  configFormat: McpConfigFormat;
  /** Supported alternate filenames, checked without creating duplicates. */
  alternativeConfigPaths?: string[];
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: ConnectorWorkspaceEnvironment;
}

interface McpServerEntryOptions {
  enableWrite?: boolean;
  indexName?: string;
  configPath?: string;
  dataDir?: string;
  cacheDir?: string;
}

export interface McpPathOptions {
  target: McpTarget;
  scope?: McpScope;
  /** Override cwd for project scope (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** Override runtime platform (testing) */
  platform?: NodeJS.Platform;
  /** Override process environment used for platform config directories (testing) */
  env?: Readonly<Record<string, string | undefined>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_SERVER_NAME = "gno";

/** All supported MCP targets */
export const MCP_TARGETS: McpTarget[] = [
  "claude-desktop",
  "claude-code",
  "codex",
  "cursor",
  "zed",
  "windsurf",
  "opencode",
  "amp",
  "lmstudio",
  "librechat",
];

/** Canonical target scope support. LibreChat has no user-global config. */
export const MCP_TARGET_SCOPES: Readonly<
  Record<McpTarget, readonly McpScope[]>
> = {
  "claude-desktop": ["user"],
  "claude-code": ["user", "project"],
  codex: ["user", "project"],
  cursor: ["user", "project"],
  zed: ["user"],
  windsurf: ["user"],
  opencode: ["user", "project"],
  amp: ["user"],
  lmstudio: ["user"],
  librechat: ["project"],
};

/** Targets that support project scope. */
export const TARGETS_WITH_PROJECT_SCOPE: McpTarget[] = MCP_TARGETS.filter(
  (target) => MCP_TARGET_SCOPES[target].includes("project")
);

/** Return the supported scopes in canonical display/operation order. */
export function getTargetScopes(target: McpTarget): readonly McpScope[] {
  return MCP_TARGET_SCOPES[target];
}

/** Default to user scope when available, otherwise the sole supported scope. */
export function getDefaultTargetScope(target: McpTarget): McpScope {
  const scopes = getTargetScopes(target);
  return scopes.includes("user") ? "user" : (scopes[0] ?? "user");
}

/** Get config format for a target */
export function getTargetConfigFormat(target: McpTarget): McpConfigFormat {
  switch (target) {
    case "codex":
      return "codex_toml";
    case "zed":
      return "context_servers";
    case "opencode":
      return "mcp";
    case "amp":
      return "amp_mcp";
    case "librechat":
      return "yaml_standard";
    default:
      return "standard";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve Claude Desktop config path based on platform.
 */
function resolveClaudeDesktopPath(home: string): string {
  const plat = platform();

  if (plat === "darwin") {
    return join(
      home,
      "Library/Application Support/Claude/claude_desktop_config.json"
    );
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData/Roaming");
    return join(appData, "Claude/claude_desktop_config.json");
  }
  // Linux and other Unix
  return join(home, ".config/Claude/claude_desktop_config.json");
}

/**
 * Resolve Claude Code config path.
 */
function resolveClaudeCodePath(
  scope: McpScope,
  home: string,
  cwd: string
): string {
  if (scope === "user") {
    return join(home, ".claude.json");
  }
  return join(cwd, ".mcp.json");
}

/**
 * Resolve Codex config path.
 */
function resolveCodexPath(scope: McpScope, home: string, cwd: string): string {
  if (scope === "user") {
    return join(home, ".codex/config.toml");
  }
  return join(cwd, ".codex/config.toml");
}

/**
 * Resolve Cursor config path.
 */
function resolveCursorPath(scope: McpScope, home: string, cwd: string): string {
  if (scope === "user") {
    const plat = platform();
    if (plat === "win32") {
      return join(home, ".cursor", "mcp.json");
    }
    return join(home, ".cursor/mcp.json");
  }
  return join(cwd, ".cursor/mcp.json");
}

/** Resolve the user-level Zed config path. */
function resolveZedPath(
  home: string,
  plat: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): string {
  if (plat === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "Zed", "settings.json");
  }
  // macOS and Linux use XDG or fallback
  const xdgConfig = env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return join(xdgConfig, "zed/settings.json");
  }
  return join(home, ".config/zed/settings.json");
}

/**
 * Resolve Windsurf config path.
 */
function resolveWindsurfPath(home: string): string {
  const plat = platform();
  if (plat === "win32") {
    return join(home, ".codeium", "windsurf", "mcp_config.json");
  }
  return join(home, ".codeium/windsurf/mcp_config.json");
}

/**
 * Resolve OpenCode config path.
 */
function resolveOpenCodePath(
  scope: McpScope,
  home: string,
  cwd: string
): string {
  if (scope === "user") {
    const plat = platform();
    if (plat === "win32") {
      return join(home, ".config", "opencode", "opencode.json");
    }
    return join(home, ".config/opencode/opencode.json");
  }
  // Project scope: opencode.json in project root
  return join(cwd, "opencode.json");
}

/**
 * Resolve Amp config path.
 */
function resolveAmpPath(home: string): string {
  const plat = platform();
  if (plat === "win32") {
    return join(home, ".config", "amp", "settings.json");
  }
  return join(home, ".config/amp/settings.json");
}

/**
 * Resolve LM Studio config path.
 */
function resolveLmStudioPath(home: string): string {
  const plat = platform();
  if (plat === "win32") {
    return join(home, ".lmstudio", "mcp.json");
  }
  return join(home, ".lmstudio/mcp.json");
}

/**
 * Resolve LibreChat config path.
 * LibreChat uses librechat.yaml in project root (project scope only).
 */
function resolveLibreChatPath(cwd: string): string {
  return join(cwd, "librechat.yaml");
}

/**
 * Resolve MCP config path for a given target and scope.
 */
export function resolveMcpConfigPath(opts: McpPathOptions): McpConfigPaths {
  const { target, cwd = process.cwd(), homeDir = homedir() } = opts;
  const runtimePlatform = opts.platform ?? platform();
  const runtimeEnv = opts.env ?? process.env;
  const scope = opts.scope ?? getDefaultTargetScope(target);
  if (!getTargetScopes(target).includes(scope)) {
    throw new Error(
      `${getTargetDisplayName(target)} does not support ${scope} scope.`
    );
  }

  const configFormat = getTargetConfigFormat(target);
  const supportsProjectScope = TARGETS_WITH_PROJECT_SCOPE.includes(target);

  switch (target) {
    case "claude-desktop":
      return {
        configPath: resolveClaudeDesktopPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case "claude-code":
      return {
        configPath: resolveClaudeCodePath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case "codex":
      return {
        configPath: resolveCodexPath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case "cursor":
      return {
        configPath: resolveCursorPath(scope, homeDir, cwd),
        supportsProjectScope,
        configFormat,
      };
    case "zed":
      return {
        configPath: resolveZedPath(homeDir, runtimePlatform, runtimeEnv),
        supportsProjectScope,
        configFormat,
      };
    case "windsurf":
      return {
        configPath: resolveWindsurfPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case "opencode": {
      const configPath = resolveOpenCodePath(scope, homeDir, cwd);
      return {
        configPath,
        alternativeConfigPaths: [configPath.replace(/\.json$/u, ".jsonc")],
        supportsProjectScope,
        configFormat,
      };
    }
    case "amp": {
      const configPath = resolveAmpPath(homeDir);
      return {
        configPath,
        alternativeConfigPaths: [configPath.replace(/\.json$/u, ".jsonc")],
        supportsProjectScope,
        configFormat,
      };
    }
    case "lmstudio":
      return {
        configPath: resolveLmStudioPath(homeDir),
        supportsProjectScope,
        configFormat,
      };
    case "librechat":
      return {
        configPath: resolveLibreChatPath(cwd),
        supportsProjectScope,
        configFormat,
      };
    default: {
      const _exhaustive: never = target;
      throw new Error(`Unknown target: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Resolve paths for all targets.
 */
export function resolveAllMcpPaths(
  scope: McpScope | "all" = "all",
  target: McpTarget | "all" = "all",
  overrides?: Pick<McpPathOptions, "cwd" | "env" | "homeDir" | "platform">
): Array<{ target: McpTarget; scope: McpScope; paths: McpConfigPaths }> {
  const targets: McpTarget[] = target === "all" ? MCP_TARGETS : [target];
  const results: Array<{
    target: McpTarget;
    scope: McpScope;
    paths: McpConfigPaths;
  }> = [];

  for (const t of targets) {
    const supportedScopes = getTargetScopes(t);
    const scopes =
      scope === "all"
        ? supportedScopes
        : supportedScopes.includes(scope)
          ? [scope]
          : [];
    const seenConfigPaths = new Set<string>();
    for (const targetScope of scopes) {
      const paths = resolveMcpConfigPath({
        target: t,
        scope: targetScope,
        ...overrides,
      });
      const configIdentity = resolve(paths.configPath);
      if (seenConfigPaths.has(configIdentity)) {
        continue;
      }
      seenConfigPaths.add(configIdentity);
      results.push({
        target: t,
        scope: targetScope,
        paths,
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
 * Return an MCP server entry bound to the GNO runtime installing it.
 * Uses absolute paths because desktop clients have a limited PATH.
 */
export function buildMcpServerEntry(
  options: McpServerEntryOptions = {}
): McpServerEntry {
  if (options.indexName !== undefined) {
    assertValidIndexName(options.indexName);
  }
  const bunPath = findBunPath();
  const args = ["run", getCurrentGnoEntrypoint()];
  appendMcpArguments(args, options);
  const dirs = resolveDirs();
  return {
    command: bunPath,
    args,
    env: {
      GNO_DATA_DIR: resolve(options.dataDir ?? dirs.data),
      GNO_CACHE_DIR: resolve(options.cacheDir ?? dirs.cache),
    },
  };
}

function appendMcpArguments(
  args: string[],
  options: McpServerEntryOptions
): void {
  if (options.indexName) {
    args.push("--index", options.indexName);
  }
  if (options.configPath) {
    args.push("--config", resolve(options.configPath));
  }
  args.push("mcp");
  if (options.enableWrite) {
    args.push("--enable-write");
  }
}
