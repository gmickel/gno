/**
 * Uninstall gno MCP server from client configurations.
 *
 * @module src/cli/commands/mcp/uninstall
 */

import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import { resolveMcpConfigLocation } from "./config-discovery.js";
import {
  removeJsoncServerEntry,
  removeTomlServerEntry,
  removeYamlServerEntry,
} from "./config-editors.js";
import {
  getServersKey,
  readMcpConfigText,
  writeMcpConfigText,
} from "./config.js";
import {
  getDefaultTargetScope,
  getTargetScopes,
  getTargetDisplayName,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "./paths.js";

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
  action: "removed" | "not_found";
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

  const resolvedPaths = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });
  const configPath = await resolveMcpConfigLocation(resolvedPaths);
  const { configFormat } = resolvedPaths;
  const content = await readMcpConfigText(configPath, {
    returnNullOnMissing: true,
  });
  if (content === null) {
    return { target, scope, configPath, action: "not_found" };
  }
  const serversKey =
    configFormat === "codex_toml" ? "mcp_servers" : getServersKey(configFormat);
  const result =
    configFormat === "codex_toml"
      ? removeTomlServerEntry(content, configPath)
      : configFormat === "yaml_standard"
        ? removeYamlServerEntry(content, configPath, serversKey)
        : removeJsoncServerEntry(content, configPath, serversKey);
  if (!result.removed) {
    return { target, scope, configPath, action: "not_found" };
  }
  await writeMcpConfigText(configPath, result.content);
  return { target, scope, configPath, action: "removed" };
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
  const target = opts.target ?? "claude-desktop";
  const scope = opts.scope ?? getDefaultTargetScope(target);
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;
  const quiet = opts.quiet ?? globals.quiet;

  // Validate scope - only some targets support project scope
  if (!getTargetScopes(target).includes(scope)) {
    throw new CliError(
      "VALIDATION",
      `${getTargetDisplayName(target)} does not support ${scope} scope.`
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

  if (result.action === "not_found") {
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
