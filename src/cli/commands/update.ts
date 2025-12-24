/**
 * gno update command implementation.
 * Sync files from disk into the index (ingestion without embedding).
 *
 * @module src/cli/commands/update
 */

import { defaultSyncService, type SyncResult } from '../../ingestion';
import { formatSyncResultLines, initStore } from './shared';

/**
 * Options for update command.
 */
export type UpdateOptions = {
  /** Override config path */
  configPath?: string;
  /** Run git pull in git repositories before scanning */
  gitPull?: boolean;
  /** Verbose output */
  verbose?: boolean;
};

/**
 * Result of update command.
 */
export type UpdateResult =
  | { success: true; result: SyncResult }
  | { success: false; error: string };

/**
 * Execute gno update command.
 */
export async function update(
  options: UpdateOptions = {}
): Promise<UpdateResult> {
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, collections } = initResult;

  try {
    // Run sync service
    const result = await defaultSyncService.syncAll(collections, store, {
      gitPull: options.gitPull,
      runUpdateCmd: true,
    });

    return { success: true, result };
  } finally {
    await store.close();
  }
}

/**
 * Format update result for output.
 */
export function formatUpdate(
  result: UpdateResult,
  options: UpdateOptions
): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  return formatSyncResultLines(result.result, options).join('\n');
}
