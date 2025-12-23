/**
 * Config saving with atomic writes.
 * Writes config to temp file, then renames to target (atomic on POSIX).
 *
 * @module src/config/saver
 */

import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expandPath, getConfigPaths } from './paths';
import { type Config, ConfigSchema } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────────────────

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; error: SaveError };

export type SaveError =
  | { code: 'VALIDATION_ERROR'; message: string }
  | { code: 'IO_ERROR'; message: string; cause: Error };

// ─────────────────────────────────────────────────────────────────────────────
// Saving Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save config to default location or specified path.
 * Uses atomic write: temp file + rename.
 */
export function saveConfig(
  config: Config,
  configPath?: string
): Promise<SaveResult> {
  const paths = getConfigPaths();
  const targetPath = configPath ? expandPath(configPath) : paths.configFile;

  return saveConfigToPath(config, targetPath);
}

/**
 * Save config to a specific file path.
 * Creates parent directories if needed.
 * Uses atomic write pattern for safety.
 */
export async function saveConfigToPath(
  config: Config,
  filePath: string
): Promise<SaveResult> {
  // Validate config before saving
  const validation = ConfigSchema.safeParse(config);
  if (!validation.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid config: ${validation.error.issues[0]?.message ?? 'unknown error'}`,
      },
    };
  }

  // Convert to YAML
  const yamlContent = Bun.YAML.stringify(config);

  // Ensure parent directory exists
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: `Failed to create config directory: ${dir}`,
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }

  // Write to temp file first (atomic write pattern)
  // Use timestamp + random suffix to avoid collision
  const tempPath = join(
    dir,
    `.index.yml.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );

  try {
    await Bun.write(tempPath, yamlContent);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: `Failed to write temp config file: ${tempPath}`,
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }

  // Rename temp to target (atomic on POSIX, needs unlink on Windows)
  try {
    // Windows: rename fails if dest exists, so unlink first (ignore if not exists)
    await unlink(filePath).catch(() => {
      /* ENOENT ok */
    });
    await rename(tempPath, filePath);
  } catch (cause) {
    // Clean up temp file on rename failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    return {
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: `Failed to save config file: ${filePath}`,
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }

  return { ok: true, path: filePath };
}

/**
 * Create directories for config, data, and cache.
 * Called during init to set up GNO storage locations.
 */
export async function ensureDirectories(): Promise<SaveResult> {
  const paths = getConfigPaths();

  try {
    await mkdir(paths.configDir, { recursive: true });
    await mkdir(paths.dataDir, { recursive: true });
    await mkdir(paths.cacheDir, { recursive: true });

    return { ok: true, path: paths.configDir };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'IO_ERROR',
        message: 'Failed to create GNO directories',
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      },
    };
  }
}
