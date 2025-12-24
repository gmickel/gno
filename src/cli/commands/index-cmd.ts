/**
 * gno index command implementation.
 * Build or update the index end-to-end (update + embed).
 *
 * @module src/cli/commands/indexCmd
 */

import { getIndexDbPath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import { defaultSyncService, type SyncResult } from '../../ingestion';
import { SqliteAdapter } from '../../store/sqlite/adapter';

/**
 * Options for index command.
 */
export type IndexOptions = {
  /** Override config path */
  configPath?: string;
  /** Scope to single collection */
  collection?: string;
  /** Run ingestion only, skip embedding */
  noEmbed?: boolean;
  /** Download models if missing */
  modelsPull?: boolean;
  /** Run git pull in git repositories */
  gitPull?: boolean;
  /** Accept defaults, no prompts */
  yes?: boolean;
  /** Verbose output */
  verbose?: boolean;
};

/**
 * Result of index command.
 */
export type IndexResult =
  | { success: true; syncResult: SyncResult; embedSkipped: boolean }
  | { success: false; error: string };

/**
 * Execute gno index command.
 */
export async function index(options: IndexOptions = {}): Promise<IndexResult> {
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

  // Filter to single collection if specified
  let collections = config.collections;
  if (options.collection) {
    collections = collections.filter((c) => c.name === options.collection);
    if (collections.length === 0) {
      return {
        success: false,
        error: `Collection not found: ${options.collection}`,
      };
    }
  }

  if (collections.length === 0) {
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

    // Run sync service (update phase)
    const syncResult = await defaultSyncService.syncAll(collections, store, {
      gitPull: options.gitPull,
      runUpdateCmd: true,
    });

    // Embedding phase (EPIC 7 - stub for now)
    const embedSkipped = options.noEmbed ?? false;
    if (!embedSkipped) {
      // TODO: EPIC 7 - Run embedding
      // For now, we skip embedding as it's not implemented yet
    }

    return { success: true, syncResult, embedSkipped };
  } finally {
    await store.close();
  }
}

/**
 * Format index result for output.
 */
export function formatIndex(
  result: IndexResult,
  options: IndexOptions
): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const { syncResult, embedSkipped } = result;
  const lines: string[] = [];

  lines.push('Indexing complete.');
  lines.push('');

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

  if (embedSkipped) {
    lines.push('');
    lines.push('Embedding skipped (--no-embed)');
  } else {
    lines.push('');
    lines.push('Embedding: not yet implemented (EPIC 7)');
  }

  return lines.join('\n');
}
