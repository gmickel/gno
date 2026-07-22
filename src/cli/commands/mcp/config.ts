/**
 * MCP config file operations.
 * Shared between install/uninstall to avoid drift.
 *
 * @module src/cli/commands/mcp/config
 */

import { copyFile, lstat, stat } from "node:fs/promises";

import type { ConnectorWorkspaceEnvironment } from "../../../core/connector-environment.js";
import type { McpConfigFormat } from "./paths.js";

import { CliError } from "../../errors.js";
import { writeMcpConfigTextAtomically } from "./atomic-config-write.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Standard mcpServers entry (Claude Desktop, Cursor, Windsurf, LM Studio) */
export interface StandardMcpEntry {
  command: string;
  args: string[];
  env?: ConnectorWorkspaceEnvironment;
}

/** OpenCode mcp entry (command is array, has type and enabled) */
export interface OpenCodeMcpEntry {
  type: "local";
  command: string[];
  enabled: boolean;
  environment?: ConnectorWorkspaceEnvironment;
}

/** Config with standard mcpServers key */
export interface McpConfig {
  mcpServers?: Record<string, StandardMcpEntry>;
  [key: string]: unknown;
}

/** Zed config with context_servers key */
export interface ZedConfig {
  context_servers?: Record<string, StandardMcpEntry>;
  [key: string]: unknown;
}

/** OpenCode config with mcp key */
export interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>;
  [key: string]: unknown;
}

/** Amp config with amp.mcpServers key */
export interface AmpConfig {
  "amp.mcpServers"?: Record<string, StandardMcpEntry>;
  [key: string]: unknown;
}

/** Union of all config types */
export type AnyMcpConfig = McpConfig | ZedConfig | OpenCodeConfig | AmpConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Read/Write Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if path exists and is a file (not directory).
 * Returns null if doesn't exist, throws if exists but not a file.
 */
async function checkConfigPath(
  configPath: string
): Promise<"file" | "missing"> {
  try {
    const pathStats = await lstat(configPath);
    if (pathStats.isSymbolicLink()) {
      let targetStats: Awaited<ReturnType<typeof stat>>;
      try {
        targetStats = await stat(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CliError(
            "RUNTIME",
            `Config path is a dangling symbolic link: ${configPath}`
          );
        }
        throw error;
      }
      if (!targetStats.isFile()) {
        throw new CliError(
          "RUNTIME",
          `Config symbolic link target is not a file: ${configPath}`
        );
      }
      return "file";
    }
    if (!pathStats.isFile()) {
      throw new CliError(
        "RUNTIME",
        `Config path exists but is not a file: ${configPath}`
      );
    }
    return "file";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw err;
  }
}

/** Read config text without parsing so format-specific editors preserve layout. */
export async function readMcpConfigText(
  configPath: string,
  options?: { returnNullOnMissing?: boolean }
): Promise<string | null> {
  const pathStatus = await checkConfigPath(configPath);
  if (pathStatus === "missing") {
    return options?.returnNullOnMissing ? null : "";
  }
  return Bun.file(configPath).text();
}

/** Write MCP text atomically while preserving the same backup contract. */
export async function writeMcpConfigText(
  configPath: string,
  content: string
): Promise<void> {
  const backupPath = `${configPath}.bak`;
  try {
    const stats = await stat(configPath);
    if (stats.isFile()) {
      try {
        const backupStats = await lstat(backupPath);
        if (!backupStats.isFile() || backupStats.isSymbolicLink()) {
          throw new CliError(
            "RUNTIME",
            `MCP config backup path is not a regular file: ${backupPath}`
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await copyFile(configPath, backupPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await writeMcpConfigTextAtomically(configPath, content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Format-aware Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the servers record key for a config format.
 */
export function getServersKey(
  format: McpConfigFormat
): "mcpServers" | "context_servers" | "mcp" | "amp.mcpServers" {
  switch (format) {
    case "standard":
    case "yaml_standard":
      return "mcpServers";
    case "context_servers":
      return "context_servers";
    case "mcp":
      return "mcp";
    case "amp_mcp":
      return "amp.mcpServers";
    case "codex_toml":
      throw new Error("Codex TOML uses dedicated config operations");
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown format: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Build entry for a specific format from standard command/args.
 */
export function buildEntry(
  command: string,
  args: string[],
  format: McpConfigFormat,
  env?: ConnectorWorkspaceEnvironment
): StandardMcpEntry | OpenCodeMcpEntry {
  if (format === "mcp") {
    // OpenCode: command is array [command, ...args]
    return {
      type: "local",
      command: [command, ...args],
      enabled: true,
      ...(env ? { environment: env } : {}),
    };
  }
  // All others use standard format
  return { command, args, ...(env ? { env } : {}) };
}
