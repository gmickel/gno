/** Security policy and remediation for connector activation verification. */

// node:fs/promises realpath has no Bun equivalent for symlink-safe provenance.
import { realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
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
  const home = homedir();
  const candidates = [
    resolve(import.meta.dir, "../index.ts"),
    resolve(import.meta.dir, "../cli/index.ts"),
    join(home, ".bun/bin/gno"),
    "/usr/local/bin/gno",
    "/opt/homebrew/bin/gno",
    ...(platform() === "win32"
      ? [
          join(home, ".bun/bin/gno.exe"),
          join(home, "AppData/Roaming/npm/gno.cmd"),
        ]
      : []),
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
      args[0] === "mcp" &&
      (args.length === 1 || (args.length === 2 && args[1] === "serve"))
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
      args[1] === "mcp" &&
      (args.length === 2 || (args.length === 3 && args[2] === "serve"))
    );
  }
  return (
    args[0] === "run" &&
    (await hasTrustedGnoIdentity(args[1] ?? "", trusted)) &&
    args[2] === "mcp" &&
    (args.length === 3 || (args.length === 4 && args[3] === "serve"))
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
