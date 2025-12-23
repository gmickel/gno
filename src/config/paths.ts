/**
 * Config path resolution utilities.
 * Wraps constants.ts for config-specific path operations.
 *
 * @module src/config/paths
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import {
  getConfigPath as getConfigPathBase,
  type ResolvedDirs,
  resolveDirs,
} from '../app/constants';

export type { ResolvedDirs } from '../app/constants';
// biome-ignore lint/performance/noBarrelFile: intentional re-export for public API
export { getConfigPath } from '../app/constants';

/**
 * Resolve ~ to home directory and normalize path.
 * Converts relative paths with ~ prefix to absolute paths.
 */
export function expandPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return join(homedir(), inputPath.slice(2));
  }
  if (inputPath === '~') {
    return homedir();
  }
  return normalize(inputPath);
}

/**
 * Ensure path is absolute, expanding ~ if needed.
 * Returns null if path cannot be made absolute.
 */
export function toAbsolutePath(inputPath: string, cwd?: string): string {
  const expanded = expandPath(inputPath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return join(cwd ?? process.cwd(), expanded);
}

/**
 * Get all config-related paths.
 * Returns paths for config file, data dir, and cache dir.
 */
export function getConfigPaths(dirs?: ResolvedDirs): {
  configFile: string;
  dataDir: string;
  cacheDir: string;
  configDir: string;
} {
  const resolved = dirs ?? resolveDirs();
  return {
    configFile: getConfigPathBase(resolved),
    configDir: resolved.config,
    dataDir: resolved.data,
    cacheDir: resolved.cache,
  };
}

/**
 * Check if config file exists.
 */
export function configExists(dirs?: ResolvedDirs): Promise<boolean> {
  const { configFile } = getConfigPaths(dirs);
  const file = Bun.file(configFile);
  return file.exists();
}
