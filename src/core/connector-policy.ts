/** Security policy and remediation for connector activation verification. */

// node:fs/promises realpath has no Bun equivalent for symlink-safe provenance.
import { realpath } from "node:fs/promises";
// node:path has no Bun equivalent for portable path identity and lookup.
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";

import type { ActivationVerificationCode } from "../store/types";

export type ConnectorVerificationCode = Extract<
  ActivationVerificationCode,
  | "connector_not_configured"
  | "connector_probe_unavailable"
  | "connector_unsupported_config"
  | "connector_start_failed"
  | "connector_timeout"
  | "connector_missing_tools"
  | "connector_status_failed"
  | "connector_search_failed"
  | "connector_result_mismatch"
  | "target_runtime_unverifiable"
>;

export interface ConnectorCommandPolicyOptions {
  /** Extra installer-resolved GNO entry paths; primarily for packaged runtimes. */
  trustedGnoEntryPaths?: string[];
}

function isGnoExecutable(path: string): boolean {
  const executable = basename(path).toLowerCase();
  return (
    executable === "gno" || executable === "gno.exe" || executable === "gno.cmd"
  );
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function executableCandidates(command: string): string[] {
  if (isAbsolute(command) || command.includes(sep)) {
    return [resolve(command)];
  }
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
}

async function resolveExecutableIdentity(
  command: string
): Promise<string | null> {
  for (const candidate of executableCandidates(command)) {
    const identity = await realpathOrNull(candidate);
    if (identity) {
      return identity;
    }
  }
  return null;
}

async function trustedGnoIdentities(
  options: ConnectorCommandPolicyOptions
): Promise<Set<string>> {
  // Conventional install paths are locators, not trust roots: symlinks resolve
  // to this package entrypoint; standalone wrappers must be explicitly trusted.
  const candidates = [
    resolve(import.meta.dir, "../index.ts"),
    ...(options.trustedGnoEntryPaths ?? []),
  ];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const identity = await realpathOrNull(candidate);
    if (identity) {
      identities.add(identity);
    }
  }
  return identities;
}

async function hasTrustedGnoIdentity(
  path: string,
  trusted: Set<string>
): Promise<boolean> {
  const identity = await realpathOrNull(path);
  return identity !== null && trusted.has(identity);
}

async function hasTrustedGnoExecutableIdentity(
  command: string,
  trusted: Set<string>
): Promise<boolean> {
  const identity = await resolveExecutableIdentity(command);
  return identity !== null && trusted.has(identity);
}

const SAFE_GLOBAL_VALUE_FLAGS = ["--index", "--config"] as const;
const MAX_SAFE_INDEX_NAME_LENGTH = 64;
const SAFE_INDEX_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeIndexName(value: string): boolean {
  return (
    value.length <= MAX_SAFE_INDEX_NAME_LENGTH &&
    SAFE_INDEX_NAME_REGEX.test(value) &&
    !value.includes("..")
  );
}

function isSafeReadOnlyMcpArgs(args: string[]): boolean {
  const seenFlags = new Set<string>();
  let position = 0;
  while (position < args.length) {
    const argument = args[position];
    if (argument === "mcp") {
      const remainder = args.slice(position + 1);
      return (
        remainder.length === 0 ||
        (remainder.length === 1 && remainder[0] === "serve")
      );
    }

    const flag = SAFE_GLOBAL_VALUE_FLAGS.find(
      (candidate) =>
        argument === candidate || argument?.startsWith(`${candidate}=`)
    );
    if (!flag || seenFlags.has(flag)) {
      return false;
    }
    seenFlags.add(flag);

    if (argument === flag) {
      const value = args[position + 1];
      if (
        !value ||
        value.startsWith("-") ||
        (flag === "--index" && !isSafeIndexName(value))
      ) {
        return false;
      }
      position += 2;
      continue;
    }

    const value = argument?.slice(flag.length + 1);
    if (!value || (flag === "--index" && !isSafeIndexName(value))) {
      return false;
    }
    position += 1;
  }
  return false;
}

/** Accept only provenance-verified direct GNO or Bun-to-local-GNO shapes. */
export async function isSafeLocalGnoMcpCommand(
  entry: { command: string; args: string[] },
  options: ConnectorCommandPolicyOptions = {}
): Promise<boolean> {
  const commandName = basename(entry.command).toLowerCase();
  const args = entry.args;
  if (
    !entry.command ||
    args.length === 0 ||
    args.includes("--enable-write") ||
    commandName === "bunx" ||
    commandName === "bunx.exe" ||
    commandName === "npx" ||
    commandName === "npx.cmd" ||
    commandName === "npx.exe"
  ) {
    return false;
  }

  const trusted = await trustedGnoIdentities(options);
  if (isGnoExecutable(entry.command)) {
    return (
      (await hasTrustedGnoExecutableIdentity(entry.command, trusted)) &&
      isSafeReadOnlyMcpArgs(args)
    );
  }
  if (commandName !== "bun" && commandName !== "bun.exe") {
    return false;
  }
  if (args[0] === "x" || args[0] === "bunx") {
    return false;
  }
  const [configuredBun, runtimeBun] = await Promise.all([
    resolveExecutableIdentity(entry.command),
    realpathOrNull(process.execPath),
  ]);
  if (!configuredBun || configuredBun !== runtimeBun) {
    return false;
  }
  if (isGnoExecutable(args[0] ?? "")) {
    return (
      (await hasTrustedGnoIdentity(args[0] ?? "", trusted)) &&
      isSafeReadOnlyMcpArgs(args.slice(1))
    );
  }
  return (
    args[0] === "run" &&
    (await hasTrustedGnoIdentity(args[1] ?? "", trusted)) &&
    isSafeReadOnlyMcpArgs(args.slice(2))
  );
}

/** Stable, bounded remediation; never includes child output or corpus text. */
export function getConnectorVerificationRemediation(
  code: ConnectorVerificationCode,
  target: string
): string {
  const label =
    target
      .replace(/[^\p{L}\p{N}._ -]/gu, "?")
      .trim()
      .slice(0, 80) || "connector";
  switch (code) {
    case "connector_not_configured":
      return `Install or configure the ${label} connector, then retry verification.`;
    case "target_runtime_unverifiable":
      return `${label} exposes no safe read-only runtime verification hook; installation is present but execution is unverified.`;
    case "connector_probe_unavailable":
      return "Repair the local lexical activation proof before verifying the connector.";
    case "connector_unsupported_config":
      return `Replace the ${label} entry with a local read-only GNO MCP command.`;
    case "connector_start_failed":
      return `Check the configured ${label} GNO executable and local permissions.`;
    case "connector_timeout":
      return `Retry ${label} verification; inspect local MCP startup if it times out again.`;
    case "connector_missing_tools":
      return `Update the ${label} GNO MCP server so gno_status and gno_search are available.`;
    case "connector_status_failed":
      return `Run gno status locally and repair the index before retrying ${label}.`;
    case "connector_search_failed":
      return `Run a collection-scoped lexical search locally before retrying ${label}.`;
    case "connector_result_mismatch":
      return `Reindex the collection and retry ${label}; the connector did not return the expected source.`;
  }
}
