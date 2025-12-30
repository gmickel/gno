/**
 * Shared test cleanup utilities.
 * Handles Windows file locking issues with SQLite.
 */

// node:fs/promises: rm with recursive/force options for test cleanup
import { rm } from 'node:fs/promises';

// Windows transient delete errors to retry on
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/**
 * Windows-safe cleanup with retry.
 * SQLite file handles may not be released immediately on Windows.
 * Retries on: EBUSY (file in use), EPERM (permission denied),
 * ENOTEMPTY (dir not empty yet), EACCES (access denied transiently).
 */
export async function safeRm(path: string, retries = 8): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ENOENT means already deleted - success
      if (err.code === 'ENOENT') {
        return;
      }
      // Retry on transient Windows errors
      if (RETRYABLE_CODES.has(err.code ?? '') && i < retries - 1) {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        continue;
      }
      // Best effort cleanup - don't fail tests over cleanup issues
      return;
    }
  }
}
