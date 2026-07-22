/** Structural validation at the MCP client-config write boundary. */

// node:path has no Bun equivalent for portable absolute-path validation.
import { isAbsolute } from "node:path";

import type { McpServerEntry } from "./paths.js";

import { normalizeConnectorWorkspaceEnvironment } from "../../../core/connector-environment.js";
import { CliError } from "../../errors.js";

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function normalizeMcpServerEntryForInstall(
  input: unknown
): McpServerEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError("VALIDATION", "MCP server entry must be an object.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CliError(
      "VALIDATION",
      "MCP server entry must be a plain object."
    );
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "command" && key !== "args" && key !== "env"
    ) ||
    typeof record.command !== "string" ||
    !record.command ||
    hasControlCharacter(record.command) ||
    !isAbsolute(record.command) ||
    !Array.isArray(record.args) ||
    record.args.length === 0 ||
    !record.args.every(
      (argument) =>
        typeof argument === "string" &&
        argument.length > 0 &&
        !hasControlCharacter(argument)
    )
  ) {
    throw new CliError(
      "VALIDATION",
      "MCP server entry requires an absolute command and non-empty string arguments."
    );
  }
  const env = normalizeConnectorWorkspaceEnvironment(record.env);
  if (env === null) {
    throw new CliError("VALIDATION", "Invalid MCP workspace environment.");
  }
  return {
    command: record.command,
    args: record.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
