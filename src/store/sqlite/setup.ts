/**
 * SQLite setup for extension support.
 *
 * Platform behavior:
 * - Linux/Windows: Bun's bundled SQLite supports extensions natively
 * - macOS: Apple's SQLite disables extension loading, requires custom SQLite
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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How SQLite extensions are loaded on this platform:
 * - 'native': Bundled SQLite supports extensions (Linux/Windows)
 * - 'custom': Custom SQLite library loaded successfully (macOS with Homebrew)
 * - 'unavailable': Extension loading not possible
 */
export type ExtensionLoadingMode = 'native' | 'custom' | 'unavailable';

/**
 * Record of a SQLite load attempt for diagnostics.
 */
export type LoadAttempt = { path: string; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

// Possible paths to Homebrew SQLite with extension support
const SQLITE_PATHS = [
  '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib', // macOS Apple Silicon
  '/usr/local/opt/sqlite3/lib/libsqlite3.dylib', // macOS Intel
];

let setupCompleted = false;
let customSqlitePath: string | null = null;
const loadAttempts: LoadAttempt[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configure Bun to use system SQLite with extension support.
 * Safe to call multiple times - only runs once.
 */
function setupCustomSqlite(): void {
  if (setupCompleted) {
    return;
  }

  // Linux/Windows: bundled SQLite supports extensions natively
  if (platform() !== 'darwin') {
    setupCompleted = true;
    return;
  }

  // macOS: try Homebrew paths
  for (const path of SQLITE_PATHS) {
    if (!existsSync(path)) {
      loadAttempts.push({ path, error: 'file not found' });
      continue;
    }
    try {
      Database.setCustomSQLite(path);
      customSqlitePath = path;
      setupCompleted = true;
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      loadAttempts.push({ path, error: message });
    }
  }

  setupCompleted = true;
}

// Run setup immediately on import
setupCustomSqlite();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the extension loading mode for this platform.
 */
export function getExtensionLoadingMode(): ExtensionLoadingMode {
  if (platform() !== 'darwin') {
    return 'native'; // Linux/Windows: bundled SQLite supports extensions
  }
  return customSqlitePath ? 'custom' : 'unavailable';
}

/**
 * Get the path to the custom SQLite library, or null if using bundled/native.
 */
export function getCustomSqlitePath(): string | null {
  return customSqlitePath;
}

/**
 * Get all SQLite load attempts for diagnostics.
 * Useful for debugging why extension loading failed.
 */
export function getLoadAttempts(): LoadAttempt[] {
  return loadAttempts.map((a) => ({ ...a }));
}

/**
 * @deprecated Use getExtensionLoadingMode() !== 'unavailable' instead
 */
export function hasExtensionSupport(): boolean {
  return getExtensionLoadingMode() !== 'unavailable';
}
