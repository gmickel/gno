/**
 * `gno mcp install --force` over an existing registration (fn-213).
 *
 * The launch path (the interpreter and the `run <entrypoint>` prefix) is
 * always rewritten. Every other argument, environment variable and entry key
 * is kept, except the options the user passed explicitly in this invocation,
 * which override their values. Defaults the installer fills in for omitted
 * options never override an existing value.
 *
 * @module src/cli/commands/mcp/repair-entry
 */

// node:path basename: no Bun path utilities.
import { basename } from "node:path";

import type { McpToolProfile } from "../../../mcp/tool-profile.js";
import type { McpConfigFormat, McpServerEntry } from "./paths.js";

import { isPlainRecord } from "./config-editors.js";

/** Install options the user passed explicitly (undefined = not passed). */
export interface ExplicitInstallValues {
  indexName?: string;
  configPath?: string;
  toolProfile?: McpToolProfile;
  enableWrite?: boolean;
}

/** An existing registration split into what GNO writes and everything else. */
export interface ExistingRegistration {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Entry keys GNO does not manage, kept verbatim. */
  extra: Record<string, unknown>;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const stringRecord = (value: unknown): Record<string, string> | null => {
  if (value === undefined) {
    return {};
  }
  if (!isPlainRecord(value)) {
    return null;
  }
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
};

/** The entry `--force` writes when it repairs an existing registration. */
export interface RepairedRegistration {
  command: string;
  args: string[];
  env: Record<string, string>;
  extra: Record<string, unknown>;
}

/** Read an existing entry; null when it is not a command registration. */
export function readExistingRegistration(
  entry: unknown,
  format: McpConfigFormat
): ExistingRegistration | null {
  if (!isPlainRecord(entry)) {
    return null;
  }
  if (format === "mcp") {
    const { command, environment, ...extra } = entry;
    const env = stringRecord(environment);
    if (!isStringArray(command) || command.length === 0 || env === null) {
      return null;
    }
    const [executable = "", ...args] = command;
    return { command: executable, args, env, extra };
  }
  const { command, args, env: rawEnv, ...extra } = entry;
  const env = stringRecord(rawEnv);
  if (typeof command !== "string" || !isStringArray(args) || env === null) {
    return null;
  }
  return { command, args, env, extra };
}

const isGnoExecutable = (command: string): boolean =>
  ["gno", "gno.exe", "gno.cmd"].includes(basename(command).toLowerCase());

/**
 * The arguments after the launch prefix, or null when the registration is
 * not a recognizable GNO MCP launch (it is then replaced as before).
 */
function argumentsAfterLaunch(
  registration: ExistingRegistration
): string[] | null {
  const { command, args } = registration;
  let rest: string[] | null = null;
  if (args[0] === "run" && args.length >= 2) {
    rest = args.slice(2);
  } else if (isGnoExecutable(command)) {
    rest = args;
  }
  return rest?.includes("mcp") ? rest : null;
}

/** Set `flag value` in `list`, replacing `flag v` or `flag=v` in place. */
function setFlag(list: string[], flag: string, value: string): string[] {
  const position = list.findIndex(
    (item) => item === flag || item.startsWith(`${flag}=`)
  );
  if (position === -1) {
    return [...list, flag, value];
  }
  const next = [...list];
  if (next[position] === flag) {
    next.splice(position, 2, flag, value);
  } else {
    next.splice(position, 1, flag, value);
  }
  return next;
}

/**
 * The entry `--force` writes over `existing`: `fresh`'s launch path, the
 * existing arguments and environment with explicit options applied, and the
 * existing keys GNO does not manage. Null when `existing` is not a GNO MCP
 * launch, so the caller writes `fresh` as before.
 */
export function repairRegistration(
  existing: ExistingRegistration,
  fresh: McpServerEntry,
  explicit: ExplicitInstallValues
): RepairedRegistration | null {
  const rest = argumentsAfterLaunch(existing);
  if (!rest) {
    return null;
  }
  const mcpPosition = rest.indexOf("mcp");
  let globals = rest.slice(0, mcpPosition);
  let subcommand = rest.slice(mcpPosition + 1);
  if (explicit.indexName !== undefined) {
    globals = setFlag(globals, "--index", explicit.indexName);
  }
  if (explicit.configPath !== undefined) {
    globals = setFlag(globals, "--config", explicit.configPath);
  }
  if (explicit.toolProfile !== undefined) {
    subcommand = setFlag(subcommand, "--tool-profile", explicit.toolProfile);
  }
  if (explicit.enableWrite && !subcommand.includes("--enable-write")) {
    subcommand = [...subcommand, "--enable-write"];
  }
  return {
    command: fresh.command,
    args: [...fresh.args.slice(0, 2), ...globals, "mcp", ...subcommand],
    env: { ...fresh.env, ...existing.env },
    extra: existing.extra,
  };
}
