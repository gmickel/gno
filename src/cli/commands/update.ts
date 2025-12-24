/**
 * gno update command implementation.
 * Sync files from disk into the index (ingestion without embedding).
 *
 * @module src/cli/commands/update
 */

import { getIndexDbPath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import { defaultSyncService, type SyncResult } from '../../ingestion';
import { SqliteAdapter } from '../../store/sqlite/adapter';

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
  // Check if initialized
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: 'GNO not initialized. Run: gno init' };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  if (config.collections.length === 0) {
    return {
      success: false,
      error: 'No collections configured. Run: gno collection add <path>',
    };
  }

  // Open database
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath();
  const paths = getConfigPaths();

  // Set configPath for status output
  store.setConfigPath(paths.configFile);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    // Sync collections from config to DB
    const syncCollResult = await store.syncCollections(config.collections);
    if (!syncCollResult.ok) {
      return { success: false, error: syncCollResult.error.message };
    }

    // Sync contexts from config to DB
    const syncCtxResult = await store.syncContexts(config.contexts ?? []);
    if (!syncCtxResult.ok) {
      return { success: false, error: syncCtxResult.error.message };
    }

    // Run sync service
    const result = await defaultSyncService.syncAll(config.collections, store, {
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

  const { result: syncResult } = result;
  const lines: string[] = [];

  for (const c of syncResult.collections) {
    lines.push(`${c.collection}:`);
    lines.push(
      `  ${c.filesAdded} added, ${c.filesUpdated} updated, ${c.filesUnchanged} unchanged`
    );
    if (c.filesErrored > 0) {
      lines.push(`  ${c.filesErrored} errors`);
    }
    if (c.filesMarkedInactive > 0) {
      lines.push(`  ${c.filesMarkedInactive} marked inactive`);
    }

    if (options.verbose && c.errors.length > 0) {
      for (const err of c.errors) {
        lines.push(`    [${err.code}] ${err.relPath}: ${err.message}`);
      }
    }
  }

  lines.push('');
  lines.push(
    `Total: ${syncResult.totalFilesAdded} added, ${syncResult.totalFilesUpdated} updated` +
      (syncResult.totalFilesErrored > 0
        ? `, ${syncResult.totalFilesErrored} errors`
        : '')
  );
  lines.push(`Duration: ${syncResult.totalDurationMs}ms`);

  return lines.join('\n');
}
