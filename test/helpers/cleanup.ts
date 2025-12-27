/**
 * Shared test cleanup utilities.
 * Handles Windows file locking issues with SQLite.
 */

import { rm } from 'node:fs/promises';

/**
 * Windows-safe cleanup with retry.
 * SQLite file handles may not be released immediately on Windows.
 */
export async function safeRm(path: string, retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < retries - 1) {
        // Wait a bit for file handles to be released
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        continue;
      }
      // On final retry or other error, just ignore - best effort cleanup
      if (i === retries - 1) {
        return;
      }
      throw e;
    }
  }
}
