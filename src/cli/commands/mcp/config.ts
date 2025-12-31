/**
 * MCP config file operations.
 * Shared between install/uninstall to avoid drift.
 *
 * @module src/cli/commands/mcp/config
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from '../../errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface McpConfig {
  mcpServers?: Record<string, { command: string; args: string[] }>;
  [key: string]: unknown;
}

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
 * Throws on malformed JSON or if path is a directory.
 */
export async function readMcpConfig(
  configPath: string,
  options?: { returnNullOnMissing?: boolean }
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
    return JSON.parse(content) as McpConfig;
  } catch {
    throw new CliError(
      'RUNTIME',
      `Malformed JSON in ${configPath}. Please fix or backup and delete the file.`
    );
  }
}

/**
 * Write MCP config atomically via temp file + rename.
 * Creates backup of existing file first.
 */
export async function writeMcpConfig(
  configPath: string,
  config: McpConfig
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

  // Write to temp file first
  const tmpPath = `${configPath}.tmp.${Date.now()}.${process.pid}`;
  try {
    await Bun.write(tmpPath, JSON.stringify(config, null, 2));
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
