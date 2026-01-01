/**
 * fts5-snowball extension loader.
 *
 * Loads vendored fts5-snowball extension for multilingual FTS5 stemming.
 * Pattern mirrors sqlite-vec loader.
 *
 * @module src/store/sqlite/fts5-snowball
 */

import type { Database } from 'bun:sqlite';
// node:fs: existsSync for sync file checks at load time
import { existsSync } from 'node:fs';
// node:path: join for cross-platform paths
import { join } from 'node:path';
// node:process: arch/platform detection (no Bun equivalent)
import { arch, platform } from 'node:process';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of attempting to load fts5-snowball.
 */
export interface Fts5SnowballLoadResult {
  loaded: boolean;
  error?: string;
  path?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform Detection
// ─────────────────────────────────────────────────────────────────────────────

function getPlatformDir(): string | null {
  const os = platform === 'win32' ? 'windows' : platform;
  const archName = arch === 'arm64' ? 'arm64' : 'x64';

  if (os === 'darwin') {
    return `darwin-${archName}`;
  }
  if (os === 'linux' && archName === 'x64') {
    return 'linux-x64';
  }
  if (os === 'windows' && archName === 'x64') {
    return 'windows-x64';
  }

  return null;
}

function getExtensionSuffix(): string {
  if (platform === 'win32') {
    return 'dll';
  }
  if (platform === 'darwin') {
    return 'dylib';
  }
  return 'so';
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get path to vendored fts5-snowball extension.
 * Returns null if not available for this platform.
 */
export function getExtensionPath(): string | null {
  const platformDir = getPlatformDir();
  if (!platformDir) {
    return null;
  }

  const suffix = getExtensionSuffix();
  const filename = `fts5stemmer.${suffix}`;

  // Resolve relative to this module (ESM-safe)
  const thisDir = fileURLToPath(new URL('.', import.meta.url));
  const vendorPath = join(
    thisDir,
    '..',
    '..',
    '..',
    'vendor',
    'fts5-snowball',
    platformDir,
    filename
  );

  if (existsSync(vendorPath)) {
    return vendorPath;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load fts5-snowball extension into database.
 *
 * Must be called after Database.setCustomSQLite() on macOS.
 * Safe to call multiple times - extension load is idempotent.
 *
 * @param db - Open database connection
 * @returns Load result with success/error info
 */
export function loadFts5Snowball(db: Database): Fts5SnowballLoadResult {
  const path = getExtensionPath();

  if (!path) {
    const platformDir = getPlatformDir();
    return {
      loaded: false,
      error: platformDir
        ? `fts5-snowball binary not found for ${platformDir}`
        : `fts5-snowball not available for ${platform}-${arch}`,
    };
  }

  try {
    db.loadExtension(path);
    return { loaded: true, path };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      loaded: false,
      error: message,
      path,
    };
  }
}

/**
 * Check if fts5-snowball is available for this platform.
 */
export function isAvailable(): boolean {
  return getExtensionPath() !== null;
}
