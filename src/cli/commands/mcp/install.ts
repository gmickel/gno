/**
 * Install gno as MCP server in client configurations.
 *
 * @module src/cli/commands/mcp/install
 */

import { DEFAULT_INDEX_NAME } from "../../../app/constants.js";
import { getConfigPaths, toAbsolutePath } from "../../../config/paths.js";
import {
  type McpToolProfile,
  parseMcpToolProfile,
} from "../../../mcp/tool-profile.js";
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
  resolveLaunchPaths,
  getDefaultTargetScope,
  getTargetScopes,
  getTargetDisplayName,
  type McpConfigFormat,
  type McpScope,
  type McpServerEntry,
  type McpTarget,
  resolveMcpConfigPath,
} from "./paths.js";
import {
  type ExplicitInstallValues,
  readExistingRegistration,
  type RepairedRegistration,
  repairRegistration,
} from "./repair-entry.js";
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
  /** Advertised tool set written into the registration (`core` or `full`). */
  toolProfile?: McpToolProfile;
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
  /** `--force` kept the existing entry's settings and repaired its launch path. */
  repaired?: boolean;
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
    /**
     * With `force` over an existing entry: keep its settings and apply only
     * these explicit options (repair-entry.ts). Without it, the entry is
     * replaced.
     */
    preserveExisting?: ExplicitInstallValues;
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

  const existing =
    alreadyExists && options.preserveExisting
      ? readExistingRegistration(parsed.entry, configFormat)
      : null;
  const repaired =
    existing && options.preserveExisting
      ? repairRegistration(existing, normalizedEntry, options.preserveExisting)
      : null;
  if (repaired) {
    // Same structural rules as a fresh entry for what this command writes.
    normalizeMcpServerEntryForInstall({
      command: repaired.command,
      args: repaired.args,
    });
  }
  const updated = repaired
    ? writeRepairedEntry(
        content,
        configPath,
        configFormat,
        serversKey,
        repaired
      )
    : writeFreshEntry(
        content,
        configPath,
        configFormat,
        serversKey,
        normalizedEntry
      );
  const writtenEntry: McpServerEntry = repaired
    ? {
        command: repaired.command,
        args: repaired.args,
        ...(Object.keys(repaired.env).length > 0
          ? { env: repaired.env as McpServerEntry["env"] }
          : {}),
      }
    : normalizedEntry;

  const wouldCreate = !alreadyExists;
  if (dryRun) {
    return {
      target,
      scope,
      configPath,
      action: wouldCreate ? "dry_run_create" : "dry_run_update",
      serverEntry: writtenEntry,
      ...(repaired ? { repaired: true } : {}),
    };
  }

  const action = wouldCreate ? "created" : "updated";
  await writeMcpConfigText(configPath, updated);

  return {
    target,
    scope,
    configPath,
    action,
    serverEntry: writtenEntry,
    ...(repaired ? { repaired: true } : {}),
  };
}

function writeFreshEntry(
  content: string,
  configPath: string,
  configFormat: McpConfigFormat,
  serversKey: string,
  normalizedEntry: McpServerEntry
): string {
  const standardEntry = {
    command: normalizedEntry.command,
    args: normalizedEntry.args,
    ...(normalizedEntry.env ? { env: normalizedEntry.env } : {}),
  };
  if (configFormat === "codex_toml") {
    return setTomlServerEntry(content, configPath, standardEntry);
  }
  if (configFormat === "yaml_standard") {
    return setYamlServerEntry(content, configPath, serversKey, standardEntry);
  }
  const entry = buildEntry(
    normalizedEntry.command,
    normalizedEntry.args,
    configFormat,
    normalizedEntry.env
  );
  return setJsoncServerEntry(content, configPath, serversKey, entry);
}

/** Write a repaired entry, keeping the keys GNO does not manage. */
function writeRepairedEntry(
  content: string,
  configPath: string,
  configFormat: McpConfigFormat,
  serversKey: string,
  repaired: RepairedRegistration
): string {
  const hasEnv = Object.keys(repaired.env).length > 0;
  if (configFormat === "codex_toml") {
    return setTomlServerEntry(
      content,
      configPath,
      { command: repaired.command, args: repaired.args },
      { env: repaired.env, extra: repaired.extra }
    );
  }
  if (configFormat === "mcp") {
    return setJsoncServerEntry(content, configPath, serversKey, {
      type: "local",
      enabled: true,
      ...repaired.extra,
      command: [repaired.command, ...repaired.args],
      ...(hasEnv ? { environment: repaired.env } : {}),
    });
  }
  const entry = {
    ...repaired.extra,
    command: repaired.command,
    args: repaired.args,
    ...(hasEnv ? { env: repaired.env } : {}),
  };
  return configFormat === "yaml_standard"
    ? setYamlServerEntry(content, configPath, serversKey, entry)
    : setJsoncServerEntry(content, configPath, serversKey, entry);
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

/** Validate the requested profile before any config file is read or written. */
function parseInstallToolProfile(value: unknown): McpToolProfile | undefined {
  try {
    return parseMcpToolProfile(value);
  } catch (error) {
    throw new CliError(
      "VALIDATION",
      error instanceof Error ? error.message : String(error)
    );
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
  const toolProfile = parseInstallToolProfile(opts.toolProfile);
  const indexName = opts.indexName ?? DEFAULT_INDEX_NAME;
  const paths = getConfigPaths();
  const configPath = toAbsolutePath(
    opts.configPath ?? paths.configFile,
    opts.cwd
  );
  // Only what the user passed overrides an existing entry under --force;
  // the defaults above never do.
  const explicit: ExplicitInstallValues = {
    ...(opts.indexName !== undefined ? { indexName } : {}),
    ...(opts.configPath !== undefined ? { configPath } : {}),
    ...(toolProfile !== undefined ? { toolProfile } : {}),
    ...(opts.enableWrite ? { enableWrite: true } : {}),
  };
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
    toolProfile,
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
    preserveExisting: explicit,
  });
  const launch = resolveLaunchPaths();
  const pinnedPaths = [launch.bun, launch.entrypoint]
    .filter((path) => path.pinned)
    .map((path) => path.path);

  // Output
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ installed: { ...result, ...(pinnedPaths.length > 0 ? { pinnedPaths } : {}) } }, null, 2)}\n`
    );
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
    process.stdout.write(`  Command: ${result.serverEntry.command}\n`);
    process.stdout.write(`  Args: ${result.serverEntry.args.join(" ")}\n`);
    writePinNote(pinnedPaths);
    return;
  }

  const verb = result.action === "created" ? "Installed" : "Updated";
  process.stdout.write(
    `${verb} gno MCP server in ${getTargetDisplayName(target)}.\n`
  );
  process.stdout.write(`  Config: ${result.configPath}\n`);
  if (result.repaired) {
    process.stdout.write(
      "  Kept the existing settings; updated the Bun and GNO paths.\n"
    );
  }
  writePinNote(pinnedPaths);
  process.stdout.write(
    `\nRestart ${getTargetDisplayName(target)} to load the server.\n`
  );
}

/** Say when a launch path stays on one installed version. */
function writePinNote(pinnedPaths: string[]): void {
  for (const path of pinnedPaths) {
    process.stdout.write(
      `  Note: ${path} is inside a versioned install directory with no version-independent link to it; this registration keeps using that version after an upgrade. Run gno mcp install --force again after upgrading (gno doctor reports it).\n`
    );
  }
}
