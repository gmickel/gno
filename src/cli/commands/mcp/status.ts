/**
 * Show MCP server installation status across all targets.
 *
 * @module src/cli/commands/mcp/status
 */

import type { ConnectorWorkspaceEnvironment } from "../../../core/connector-environment";
import type { McpConnectorVerificationTarget } from "../../../core/connector-verifier";
import type { StandardMcpEntry } from "./config.js";

import { normalizeConnectorWorkspaceEnvironment } from "../../../core/connector-environment";
import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import {
  configPathEntryExists,
  resolveMcpConfigLocation,
} from "./config-discovery.js";
import {
  getJsoncServerEntry,
  getTomlServerEntry,
  getYamlServerEntry,
} from "./config-editors.js";
import { getServersKey } from "./config.js";
import {
  getTargetScopes,
  getTargetDisplayName,
  MCP_TARGETS,
  type McpConfigFormat,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
} from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusOptions {
  target?: McpTarget | "all";
  scope?: McpScope | "all";
  /** Override cwd (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** JSON output */
  json?: boolean;
}

export interface McpTargetStatus {
  target: McpTarget;
  scope: McpScope;
  configPath: string;
  configured: boolean;
  serverEntry?: {
    command: string;
    args: string[];
    env?: ConnectorWorkspaceEnvironment;
  };
  error?: string;
}

/** Verification-only identity; deliberately omitted from status JSON output. */
const configIdentityByStatus = new WeakMap<McpTargetStatus, string>();

/** Project a parsed target status into the read-only activation verifier seam. */
export function toMcpConnectorVerificationTarget(
  id: string,
  status: McpTargetStatus
): McpConnectorVerificationTarget {
  const serverEntry = normalizeEntry(status.serverEntry, "standard");
  const configured = status.configured && serverEntry !== null;
  const configIdentity = configIdentityByStatus.get(status);
  return {
    kind: "mcp",
    id,
    target: status.target,
    scope: status.scope,
    configPath: status.configPath,
    configured,
    ...(serverEntry ? { serverEntry } : {}),
    ...(configIdentity ? { configIdentity } : {}),
    ...(status.error || (status.configured && !serverEntry)
      ? { configError: true }
      : {}),
  };
}

interface StatusResult {
  targets: McpTargetStatus[];
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
  entry: unknown,
  configFormat: McpConfigFormat
): StandardMcpEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (configFormat === "mcp") {
    // OpenCode format: command is array [command, ...args]
    if (
      record.type !== "local" ||
      (record.enabled !== undefined && record.enabled !== true) ||
      !Array.isArray(record.command) ||
      record.command.length === 0 ||
      !record.command.every((part) => typeof part === "string") ||
      Object.keys(record).some(
        (key) =>
          key !== "type" &&
          key !== "command" &&
          key !== "enabled" &&
          key !== "environment"
      )
    ) {
      return null;
    }
    const [command = "", ...args] = record.command;
    if (!command) {
      return null;
    }
    const env = normalizeConnectorWorkspaceEnvironment(record.environment);
    if (env === null) {
      return null;
    }
    return {
      command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  if (
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string") ||
    Object.keys(record).some(
      (key) => key !== "command" && key !== "args" && key !== "env"
    )
  ) {
    return null;
  }
  const env = normalizeConnectorWorkspaceEnvironment(record.env);
  if (env === null) {
    return null;
  }
  return {
    command: record.command,
    args: record.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function entryIdentity(entry: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(entry) ?? "undefined");
  return hasher.digest("hex");
}

export async function checkMcpTargetStatus(
  target: McpTarget,
  scope: McpScope,
  options: { cwd?: string; homeDir?: string }
): Promise<McpTargetStatus> {
  const { cwd, homeDir } = options;

  const resolvedPaths = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });
  let configPath = resolvedPaths.configPath;
  const { configFormat } = resolvedPaths;

  try {
    configPath = await resolveMcpConfigLocation(resolvedPaths);
    if (!(await configPathEntryExists(configPath))) {
      return { target, scope, configPath, configured: false };
    }
    const content = await Bun.file(configPath).text();
    if (!content.trim()) {
      return { target, scope, configPath, configured: false };
    }
    const serversKey =
      configFormat === "codex_toml"
        ? "mcp_servers"
        : getServersKey(configFormat);
    const parsed =
      configFormat === "codex_toml"
        ? getTomlServerEntry(content, configPath)
        : configFormat === "yaml_standard"
          ? getYamlServerEntry(content, configPath, serversKey)
          : getJsoncServerEntry(content, configPath, serversKey);
    if (!parsed.exists) {
      return { target, scope, configPath, configured: false };
    }
    const entry = parsed.entry;
    if (
      configFormat === "mcp" &&
      entry &&
      typeof entry === "object" &&
      (entry as { enabled?: unknown }).enabled === false
    ) {
      return { target, scope, configPath, configured: false };
    }
    const configIdentity = entryIdentity(entry);
    const serverEntry = normalizeEntry(entry, configFormat);
    if (!serverEntry) {
      const status: McpTargetStatus = {
        target,
        scope,
        configPath,
        configured: false,
        error: "Malformed MCP server entry",
      };
      configIdentityByStatus.set(status, configIdentity);
      return status;
    }
    const status: McpTargetStatus = {
      target,
      scope,
      configPath,
      configured: true,
      serverEntry,
    };
    configIdentityByStatus.set(status, configIdentity);
    return status;
  } catch (error) {
    const format =
      configFormat === "codex_toml"
        ? "TOML"
        : configFormat === "yaml_standard"
          ? "YAML"
          : "JSON";
    return {
      target,
      scope,
      configPath,
      configured: false,
      error:
        error instanceof Error && error.message.startsWith("Ambiguous MCP")
          ? error.message
          : `Malformed ${format}`,
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
// oxlint-disable-next-line max-lines-per-function -- status display with multiple targets and scopes
export async function statusMcp(opts: StatusOptions = {}): Promise<void> {
  const targetFilter = opts.target ?? "all";
  const scopeFilter = opts.scope ?? "all";
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;

  if (
    targetFilter !== "all" &&
    scopeFilter !== "all" &&
    !getTargetScopes(targetFilter).includes(scopeFilter)
  ) {
    throw new CliError(
      "VALIDATION",
      `${getTargetDisplayName(targetFilter)} does not support ${scopeFilter} scope.`
    );
  }

  const targets: McpTarget[] =
    targetFilter === "all" ? MCP_TARGETS : [targetFilter];

  const results: McpTargetStatus[] = [];

  for (const target of targets) {
    const scopes = getTargetScopes(target).filter(
      (scope) => scopeFilter === "all" || scope === scopeFilter
    );
    for (const scope of scopes) {
      results.push(
        await checkMcpTargetStatus(target, scope, {
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
  process.stdout.write("MCP Server Status\n");
  process.stdout.write(`${"─".repeat(50)}\n\n`);

  for (const status of results) {
    const targetName = getTargetDisplayName(status.target);
    const scopeLabel = status.scope === "project" ? " (project)" : "";
    const statusIcon = status.configured ? "✓" : "✗";
    const statusText = status.configured ? "configured" : "not configured";

    process.stdout.write(
      `${statusIcon} ${targetName}${scopeLabel}: ${statusText}\n`
    );

    if (status.configured && status.serverEntry) {
      process.stdout.write(`    Command: ${status.serverEntry.command}\n`);
      process.stdout.write(`    Args: ${status.serverEntry.args.join(" ")}\n`);
    }

    if (status.error) {
      process.stdout.write(`    Error: ${status.error}\n`);
    }

    process.stdout.write(`    Config: ${status.configPath}\n\n`);
  }

  process.stdout.write(`${configured}/${results.length} targets configured\n`);
}
