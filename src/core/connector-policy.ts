/** Security policy and remediation for connector activation verification. */

// node:path has no Bun equivalent for portable command-shape validation.
import { basename, dirname, normalize } from "node:path";

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

function isGnoExecutable(path: string): boolean {
  const executable = basename(path).toLowerCase();
  return executable === "gno" || executable === "gno.exe";
}

function isGnoSourceEntry(path: string): boolean {
  const normalized = normalize(path);
  return (
    basename(normalized).toLowerCase() === "index.ts" &&
    basename(dirname(normalized)).toLowerCase() === "cli" &&
    basename(dirname(dirname(normalized))).toLowerCase() === "src" &&
    basename(dirname(dirname(dirname(normalized)))).toLowerCase() === "gno"
  );
}

/** Accept only direct GNO or Bun-to-local-GNO stdio command shapes. */
export function isSafeLocalGnoMcpCommand(entry: {
  command: string;
  args: string[];
}): boolean {
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

  if (isGnoExecutable(entry.command)) {
    return (
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
  if (isGnoExecutable(args[0] ?? "")) {
    return (
      args[1] === "mcp" &&
      (args.length === 2 || (args.length === 3 && args[2] === "serve"))
    );
  }
  return (
    args[0] === "run" &&
    isGnoSourceEntry(args[1] ?? "") &&
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
