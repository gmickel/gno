/**
 * SQLite setup for extension support.
 * Bun's bundled SQLite doesn't support extensions.
 * This module configures Bun to use system SQLite (Homebrew) when available.
 *
 * MUST be imported before any Database is created.
 *
 * @module src/store/sqlite/setup
 */

import { Database } from 'bun:sqlite';
// node:fs: existsSync for checking file existence (no async needed at module load)
import { existsSync } from 'node:fs';
// node:os: platform detection (no Bun equivalent)
import { platform } from 'node:os';

// Possible paths to Homebrew SQLite with extension support
const SQLITE_PATHS = [
  '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib', // macOS Apple Silicon
  '/usr/local/opt/sqlite3/lib/libsqlite3.dylib', // macOS Intel
];

let customSqliteLoaded = false;
let customSqlitePath: string | null = null;

/**
 * Configure Bun to use system SQLite with extension support.
 * Safe to call multiple times - only runs once.
 */
function setupCustomSqlite(): void {
  if (customSqliteLoaded) {
    return;
  }

  // Only attempt on macOS
  if (platform() !== 'darwin') {
    customSqliteLoaded = true;
    return;
  }

  for (const path of SQLITE_PATHS) {
    if (existsSync(path)) {
      try {
        Database.setCustomSQLite(path);
        customSqlitePath = path;
        customSqliteLoaded = true;
        return;
      } catch {
        // Failed to load, try next path
      }
    }
  }

  customSqliteLoaded = true;
}

// Run setup immediately on import
setupCustomSqlite();

/**
 * Check if custom SQLite with extension support is available.
 */
export function hasExtensionSupport(): boolean {
  return customSqlitePath !== null;
}

/**
 * Get the path to the custom SQLite library, or null if using bundled.
 */
export function getCustomSqlitePath(): string | null {
  return customSqlitePath;
}
