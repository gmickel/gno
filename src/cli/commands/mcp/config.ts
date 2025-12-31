/**
 * MCP config file operations.
 * Shared between install/uninstall to avoid drift.
 *
 * @module src/cli/commands/mcp/config
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../../errors.js';
import type { McpConfigFormat } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Standard mcpServers entry (Claude Desktop, Cursor, Windsurf, LM Studio) */
export interface StandardMcpEntry {
  command: string;
  args: string[];
}

/** OpenCode mcp entry (command is array, has type and enabled) */
export interface OpenCodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
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
  'amp.mcpServers'?: Record<string, StandardMcpEntry>;
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
): Promise<'file' | 'missing'> {
  try {
    const stats = await stat(configPath);
    if (!stats.isFile()) {
      throw new CliError(
        'RUNTIME',
        `Config path exists but is not a file: ${configPath}`
      );
    }
    return 'file';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw err;
  }
}

/**
 * Read and parse MCP config file.
 * Returns empty config if file doesn't exist.
 * Returns null if file doesn't exist AND returnNullOnMissing is true.
 * Throws on malformed JSON/YAML or if path is a directory.
 */
export async function readMcpConfig(
  configPath: string,
  options?: { returnNullOnMissing?: boolean; yaml?: boolean }
): Promise<McpConfig | null> {
  const pathStatus = await checkConfigPath(configPath);

  if (pathStatus === 'missing') {
    return options?.returnNullOnMissing ? null : {};
  }

  const file = Bun.file(configPath);
  const content = await file.text();

  // Handle empty file
  if (!content.trim()) {
    return {};
  }

  try {
    if (options?.yaml) {
      return Bun.YAML.parse(content) as McpConfig;
    }
    return JSON.parse(content) as McpConfig;
  } catch {
    const format = options?.yaml ? 'YAML' : 'JSON';
    throw new CliError(
      'RUNTIME',
      `Malformed ${format} in ${configPath}. Please fix or backup and delete the file.`
    );
  }
}

/**
 * Write MCP config atomically via temp file + rename.
 * Creates backup of existing file first.
 */
export async function writeMcpConfig(
  configPath: string,
  config: AnyMcpConfig,
  options?: { yaml?: boolean }
): Promise<void> {
  const dir = dirname(configPath);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  // Create backup of existing file
  try {
    const stats = await stat(configPath);
    if (stats.isFile()) {
      await copyFile(configPath, `${configPath}.bak`);
    }
  } catch {
    // File doesn't exist, no backup needed
  }

  // Serialize content
  const content = options?.yaml
    ? Bun.YAML.stringify(config)
    : JSON.stringify(config, null, 2);

  // Write to temp file first
  const tmpPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
  try {
    await Bun.write(tmpPath, content);
    // Atomic rename
    await rename(tmpPath, configPath);
  } catch (err) {
    // Cleanup temp file on error
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format-aware Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the servers record key for a config format.
 */
export function getServersKey(
  format: McpConfigFormat
): 'mcpServers' | 'context_servers' | 'mcp' | 'amp.mcpServers' {
  switch (format) {
    case 'standard':
    case 'yaml_standard':
      return 'mcpServers';
    case 'context_servers':
      return 'context_servers';
    case 'mcp':
      return 'mcp';
    case 'amp_mcp':
      return 'amp.mcpServers';
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown format: ${_exhaustive}`);
    }
  }
}

/**
 * Check if format uses YAML.
 */
export function isYamlFormat(format: McpConfigFormat): boolean {
  return format === 'yaml_standard';
}

/**
 * Check if a server entry exists in config for given format.
 */
export function hasServerEntry(
  config: AnyMcpConfig,
  serverName: string,
  format: McpConfigFormat
): boolean {
  const key = getServersKey(format);
  const servers = config[key] as Record<string, unknown> | undefined;
  return !!servers?.[serverName];
}

/**
 * Get server entry from config.
 */
export function getServerEntry(
  config: AnyMcpConfig,
  serverName: string,
  format: McpConfigFormat
): StandardMcpEntry | OpenCodeMcpEntry | undefined {
  const key = getServersKey(format);
  const servers = config[key] as
    | Record<string, StandardMcpEntry | OpenCodeMcpEntry>
    | undefined;
  return servers?.[serverName];
}

/**
 * Build entry for a specific format from standard command/args.
 */
export function buildEntry(
  command: string,
  args: string[],
  format: McpConfigFormat
): StandardMcpEntry | OpenCodeMcpEntry {
  if (format === 'mcp') {
    // OpenCode: command is array [command, ...args]
    return {
      type: 'local',
      command: [command, ...args],
      enabled: true,
    };
  }
  // All others use standard format
  return { command, args };
}

/**
 * Add or update server entry in config.
 */
export function setServerEntry(
  config: AnyMcpConfig,
  serverName: string,
  entry: StandardMcpEntry | OpenCodeMcpEntry,
  format: McpConfigFormat
): void {
  const key = getServersKey(format);

  // Initialize servers record if needed
  if (!config[key]) {
    (config as Record<string, unknown>)[key] = {};
  }

  const servers = config[key] as Record<
    string,
    StandardMcpEntry | OpenCodeMcpEntry
  >;
  servers[serverName] = entry;
}

/**
 * Remove server entry from config.
 * Returns true if entry was removed, false if not found.
 */
export function removeServerEntry(
  config: AnyMcpConfig,
  serverName: string,
  format: McpConfigFormat
): boolean {
  const key = getServersKey(format);
  const servers = config[key] as
    | Record<string, StandardMcpEntry | OpenCodeMcpEntry>
    | undefined;

  if (!servers?.[serverName]) {
    return false;
  }

  delete servers[serverName];

  // Clean up empty servers object
  if (Object.keys(servers).length === 0) {
    delete (config as Record<string, unknown>)[key];
  }

  return true;
}
