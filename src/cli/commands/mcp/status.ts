/**
 * Show MCP server installation status across all targets.
 *
 * @module src/cli/commands/mcp/status
 */

import type { ConnectorWorkspaceEnvironment } from "../../../core/connector-environment";
import type { McpConnectorVerificationTarget } from "../../../core/connector-verifier";
import type { McpToolProfile } from "../../../mcp/tool-profile.js";
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
  readMcpToolProfileFromArgs,
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
  /** Tool profile the registration starts with; `full` when its args carry none. */
  toolProfile?: McpToolProfile;
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

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Client settings that never change how the command runs: timeouts, labels
 * and approval prompts. Anything else (cwd, url, headers, another transport,
 * unknown keys) keeps an entry fail-closed, because the connector verifier
 * starts the registered command.
 */
const INERT_ENTRY_KEYS: Record<string, (value: unknown) => boolean> = {
  type: (value) => value === "stdio",
  timeout: (value) => typeof value === "number",
  startup_timeout_sec: (value) => typeof value === "number",
  tool_timeout_sec: (value) => typeof value === "number",
  description: (value) => typeof value === "string",
  autoApprove: isStringArray,
  alwaysAllow: isStringArray,
  enabled: (value) => typeof value === "boolean",
  disabled: (value) => typeof value === "boolean",
};

/** Keys other than the launch keys are all known and inert. */
function hasOnlyInertExtras(
  record: Record<string, unknown>,
  launchKeys: readonly string[],
  allowed: Record<string, (value: unknown) => boolean>
): boolean {
  return Object.entries(record).every(
    ([key, value]) =>
      launchKeys.includes(key) || (allowed[key]?.(value) ?? false)
  );
}

/** OpenCode writes `type: "local"` and `enabled` itself. */
const OPENCODE_INERT_KEYS: Record<string, (value: unknown) => boolean> = {
  timeout: (value) => typeof value === "number",
  enabled: (value) => typeof value === "boolean",
};

/** A registration the client has switched off. */
function isDisabledEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return record.enabled === false || record.disabled === true;
}

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
      !hasOnlyInertExtras(
        record,
        ["type", "command", "environment"],
        OPENCODE_INERT_KEYS
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
    !hasOnlyInertExtras(record, ["command", "args", "env"], INERT_ENTRY_KEYS)
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
    // A registration the client has switched off is not configured.
    if (isDisabledEntry(entry)) {
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
      toolProfile: readMcpToolProfileFromArgs(serverEntry.args),
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
      process.stdout.write(`    Profile: ${status.toolProfile ?? "full"}\n`);
    }

    if (status.error) {
      process.stdout.write(`    Error: ${status.error}\n`);
    }

    process.stdout.write(`    Config: ${status.configPath}\n\n`);
  }

  process.stdout.write(`${configured}/${results.length} targets configured\n`);
}
