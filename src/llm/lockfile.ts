/**
 * Cross-process lockfile for model cache operations.
 * Uses O_EXCL create + stale lock recovery pattern.
 *
 * @module src/llm/lockfile
 */

import { open, rename, rm, stat } from 'node:fs/promises';
// node:os: hostname and user for lock ownership
import { hostname, userInfo } from 'node:os';
// node:path: join for manifest lock path
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default lock TTL in milliseconds (24 hours - long to avoid stealing during slow downloads) */
const DEFAULT_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

/** Retry delay for lock acquisition (ms) */
const LOCK_RETRY_DELAY_MS = 500;

/** Max retries before giving up (~10 minutes for multi-GB downloads) */
const LOCK_MAX_RETRIES = 1200;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface LockMeta {
  pid: number;
  hostname: string;
  user: string;
  createdAt: string;
}

export interface LockHandle {
  /** Release the lock */
  release: () => Promise<void>;
  /** Path to lock file */
  path: string;
}

export interface LockOptions {
  /** Lock TTL in milliseconds (see DEFAULT_LOCK_TTL_MS) */
  ttlMs?: number;
  /** Max retries before giving up (see LOCK_MAX_RETRIES) */
  maxRetries?: number;
  /** Delay between retries in ms (see LOCK_RETRY_DELAY_MS) */
  retryDelayMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getLockMeta(): LockMeta {
  return {
    pid: process.pid,
    hostname: hostname(),
    user: userInfo().username,
    createdAt: new Date().toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a lockfile is stale (older than TTL or owner process dead).
 */
async function isLockStale(lockPath: string, ttlMs: number): Promise<boolean> {
  try {
    const stats = await stat(lockPath);
    const age = Date.now() - stats.mtimeMs;

    // Lock older than TTL is definitely stale
    if (age > ttlMs) {
      return true;
    }

    // TODO: Could also check if PID is alive on same hostname
    // For now, just use TTL-based staleness
    return false;
  } catch {
    // Lock doesn't exist or can't be read
    return true;
  }
}

/**
 * Create lock file exclusively (O_EXCL).
 * Fails if file already exists.
 */
async function createLockExclusive(
  lockPath: string,
  meta: LockMeta
): Promise<void> {
  const content = JSON.stringify(meta, null, 2);

  // Create lock file with O_EXCL - fails if exists
  const fh = await open(lockPath, 'wx');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquire a lock on a path.
 * Returns a handle that must be released when done.
 *
 * @param lockPath - Path to the lock file (usually model path + '.lock')
 * @param options - Lock options
 * @returns Lock handle or null if acquisition failed
 */
export async function acquireLock(
  lockPath: string,
  options?: LockOptions
): Promise<LockHandle | null> {
  const ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const maxRetries = options?.maxRetries ?? LOCK_MAX_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? LOCK_RETRY_DELAY_MS;

  let retries = 0;

  while (retries < maxRetries) {
    try {
      // Try to create lock file exclusively
      const meta = getLockMeta();
      await createLockExclusive(lockPath, meta);

      // Success! Return handle
      return {
        path: lockPath,
        release: async () => {
          await rm(lockPath, { force: true }).catch(() => undefined);
        },
      };
    } catch (e) {
      // EEXIST means lock exists
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') {
        // Check if stale
        const stale = await isLockStale(lockPath, ttlMs);

        if (stale) {
          // Atomic stale recovery: rename to .stale, then try again
          const stalePath = `${lockPath}.stale.${process.pid}`;
          try {
            await rename(lockPath, stalePath);
            // Clean up stale file (ignore errors)
            await rm(stalePath, { force: true }).catch(() => undefined);
            // Try again immediately
            continue;
          } catch {
            // Someone else grabbed it - retry with backoff
          }
        }

        // Lock is held - wait and retry
        retries++;
        await sleep(retryDelayMs);
        continue;
      }

      // Other error (permissions, etc.)
      throw e;
    }
  }

  // Failed to acquire after max retries
  return null;
}

/**
 * Execute a function while holding a lock.
 * Automatically releases lock when done.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T | null> {
  const lock = await acquireLock(lockPath, options);
  if (!lock) {
    return null;
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Get the lock path for a model file path.
 */
export function getLockPath(modelPath: string): string {
  return `${modelPath}.lock`;
}

/**
 * Get the manifest lock path for a cache directory.
 */
export function getManifestLockPath(cacheDir: string): string {
  return join(cacheDir, 'manifest.lock');
}
