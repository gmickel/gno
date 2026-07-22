/**
 * Install gno as MCP server in client configurations.
 *
 * @module src/cli/commands/mcp/install
 */

import { DEFAULT_INDEX_NAME } from "../../../app/constants.js";
import { getConfigPaths, toAbsolutePath } from "../../../config/paths.js";
import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import { resolveMcpConfigLocation } from "./config-discovery.js";
import {
  getJsoncServerEntry,
  getTomlServerEntry,
  getYamlServerEntry,
  setJsoncServerEntry,
  setTomlServerEntry,
  setYamlServerEntry,
} from "./config-editors.js";
import {
  buildEntry,
  getServersKey,
  readMcpConfigText,
  writeMcpConfigText,
} from "./config.js";
import {
  buildMcpServerEntry,
  getDefaultTargetScope,
  getTargetScopes,
  getTargetDisplayName,
  type McpScope,
  type McpServerEntry,
  type McpTarget,
  resolveMcpConfigPath,
} from "./paths.js";
import { normalizeMcpServerEntryForInstall } from "./server-entry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  target?: McpTarget;
  scope?: McpScope;
  force?: boolean;
  dryRun?: boolean;
  enableWrite?: boolean;
  /** Index identity persisted in the installed MCP command. */
  indexName?: string;
  /** Active GNO config persisted as a canonical absolute path. */
  configPath?: string;
  /** Override cwd (testing) */
  cwd?: string;
  /** Override home dir (testing) */
  homeDir?: string;
  /** JSON output */
  json?: boolean;
  /** Quiet mode */
  quiet?: boolean;
}

export interface McpInstallResult {
  target: McpTarget;
  scope: McpScope;
  configPath: string;
  action: "created" | "updated" | "dry_run_create" | "dry_run_update";
  serverEntry: McpServerEntry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install gno to a single target.
 */
export async function installMcpToTarget(
  target: McpTarget,
  scope: McpScope,
  serverEntry: McpServerEntry,
  options: {
    force?: boolean;
    dryRun?: boolean;
    cwd?: string;
    homeDir?: string;
  }
): Promise<McpInstallResult> {
  const { force = false, dryRun = false, cwd, homeDir } = options;
  const normalizedEntry = normalizeMcpServerEntryForInstall(serverEntry);
  const resolvedPaths = resolveMcpConfigPath({
    target,
    scope,
    cwd,
    homeDir,
  });
  const configPath = await resolveMcpConfigLocation(resolvedPaths);
  const { configFormat } = resolvedPaths;
  const content = (await readMcpConfigText(configPath)) ?? "";
  const serversKey =
    configFormat === "codex_toml" ? "mcp_servers" : getServersKey(configFormat);
  const parsed =
    configFormat === "codex_toml"
      ? getTomlServerEntry(content, configPath)
      : configFormat === "yaml_standard"
        ? getYamlServerEntry(content, configPath, serversKey)
        : getJsoncServerEntry(content, configPath, serversKey);
  const alreadyExists = parsed.exists;
  if (alreadyExists && !force) {
    throw new CliError(
      "VALIDATION",
      `${getTargetDisplayName(target)} already has gno configured.\n` +
        `  Config: ${configPath}\n` +
        "  Use --force to overwrite."
    );
  }

  const entry = buildEntry(
    normalizedEntry.command,
    normalizedEntry.args,
    configFormat,
    normalizedEntry.env
  );
  const standardEntry = {
    command: normalizedEntry.command,
    args: normalizedEntry.args,
    ...(normalizedEntry.env ? { env: normalizedEntry.env } : {}),
  };
  const updated =
    configFormat === "codex_toml"
      ? setTomlServerEntry(content, configPath, standardEntry)
      : configFormat === "yaml_standard"
        ? setYamlServerEntry(content, configPath, serversKey, standardEntry)
        : setJsoncServerEntry(content, configPath, serversKey, entry);

  const wouldCreate = !alreadyExists;
  if (dryRun) {
    return {
      target,
      scope,
      configPath,
      action: wouldCreate ? "dry_run_create" : "dry_run_update",
      serverEntry: normalizedEntry,
    };
  }

  const action = wouldCreate ? "created" : "updated";
  await writeMcpConfigText(configPath, updated);

  return {
    target,
    scope,
    configPath,
    action,
    serverEntry: normalizedEntry,
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
  const target = opts.target ?? "claude-desktop";
  const scope = opts.scope ?? getDefaultTargetScope(target);
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  const enableWrite = opts.enableWrite ?? false;
  const indexName = opts.indexName ?? DEFAULT_INDEX_NAME;
  const paths = getConfigPaths();
  const configPath = toAbsolutePath(
    opts.configPath ?? paths.configFile,
    opts.cwd
  );
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

  // Build server entry (uses process.execPath, always succeeds)
  const serverEntry = buildMcpServerEntry({
    enableWrite,
    indexName,
    configPath,
    dataDir: toAbsolutePath(paths.dataDir, opts.cwd),
    cacheDir: toAbsolutePath(paths.cacheDir, opts.cwd),
  });

  // Install
  const result = await installMcpToTarget(target, scope, serverEntry, {
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
    const dryRunVerb = result.action === "dry_run_create" ? "create" : "update";
    process.stdout.write("Dry run - no changes made.\n\n");
    process.stdout.write(
      `Would ${dryRunVerb} gno in ${getTargetDisplayName(target)}:\n`
    );
    process.stdout.write(`  Config: ${result.configPath}\n`);
    process.stdout.write(`  Command: ${serverEntry.command}\n`);
    process.stdout.write(`  Args: ${serverEntry.args.join(" ")}\n`);
    return;
  }

  const verb = result.action === "created" ? "Installed" : "Updated";
  process.stdout.write(
    `${verb} gno MCP server in ${getTargetDisplayName(target)}.\n`
  );
  process.stdout.write(`  Config: ${result.configPath}\n\n`);
  process.stdout.write(
    `Restart ${getTargetDisplayName(target)} to load the server.\n`
  );
}
