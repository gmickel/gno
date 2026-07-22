/**
 * Show MCP server installation status across all targets.
 *
 * @module src/cli/commands/mcp/status
 */

import type { McpConnectorVerificationTarget } from "../../../core/connector-verifier";

import { getGlobals } from "../../program.js";
import {
  type AnyMcpConfig,
  getServerEntry,
  getServersKey,
  isYamlFormat,
  type StandardMcpEntry,
} from "./config.js";
import {
  getTargetDisplayName,
  MCP_SERVER_NAME,
  MCP_TARGETS,
  type McpConfigFormat,
  type McpScope,
  type McpTarget,
  resolveMcpConfigPath,
  TARGETS_WITH_PROJECT_SCOPE,
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
  serverEntry?: { command: string; args: string[] };
  error?: string;
}

/** Project a parsed target status into the read-only activation verifier seam. */
export function toMcpConnectorVerificationTarget(
  id: string,
  status: McpTargetStatus
): McpConnectorVerificationTarget {
  const serverEntry = normalizeEntry(status.serverEntry, "standard");
  const configured = status.configured && serverEntry !== null;
  return {
    kind: "mcp",
    id,
    target: status.target,
    scope: status.scope,
    configPath: status.configPath,
    configured,
    ...(serverEntry ? { serverEntry } : {}),
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
      record.enabled !== true ||
      !Array.isArray(record.command) ||
      record.command.length === 0 ||
      !record.command.every((part) => typeof part === "string")
    ) {
      return null;
    }
    const [command = "", ...args] = record.command;
    if (!command) {
      return null;
    }
    return { command, args };
  }
  if (
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string")
  ) {
    return null;
  }
  return { command: record.command, args: record.args };
}

function hasOwnServerEntry(
  config: AnyMcpConfig,
  configFormat: McpConfigFormat
): boolean {
  const servers = config[getServersKey(configFormat)];
  return (
    !!servers &&
    typeof servers === "object" &&
    Object.hasOwn(servers, MCP_SERVER_NAME)
  );
}

export async function checkMcpTargetStatus(
  target: McpTarget,
  scope: McpScope,
  options: { cwd?: string; homeDir?: string }
): Promise<McpTargetStatus> {
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
    const entry: unknown = getServerEntry(
      config,
      MCP_SERVER_NAME,
      configFormat
    );

    if (hasOwnServerEntry(config, configFormat)) {
      const serverEntry = normalizeEntry(entry, configFormat);
      if (!serverEntry) {
        return {
          target,
          scope,
          configPath,
          configured: false,
          error: "Malformed MCP server entry",
        };
      }
      return { target, scope, configPath, configured: true, serverEntry };
    }

    return { target, scope, configPath, configured: false };
  } catch {
    const format = isYamlFormat(configFormat) ? "YAML" : "JSON";
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
// oxlint-disable-next-line max-lines-per-function -- status display with multiple targets and scopes
export async function statusMcp(opts: StatusOptions = {}): Promise<void> {
  const targetFilter = opts.target ?? "all";
  const scopeFilter = opts.scope ?? "all";
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;

  const targets: McpTarget[] =
    targetFilter === "all" ? MCP_TARGETS : [targetFilter];

  const results: McpTargetStatus[] = [];

  for (const target of targets) {
    const supportsProject = TARGETS_WITH_PROJECT_SCOPE.includes(target);

    if (supportsProject) {
      // Targets that support both scopes
      const scopes: McpScope[] =
        scopeFilter === "all" ? ["user", "project"] : [scopeFilter];

      for (const scope of scopes) {
        results.push(
          await checkMcpTargetStatus(target, scope, {
            cwd: opts.cwd,
            homeDir: opts.homeDir,
          })
        );
      }
    } else if (scopeFilter === "all" || scopeFilter === "user") {
      // User scope only - skip if filtering by project
      results.push(
        await checkMcpTargetStatus(target, "user", {
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
