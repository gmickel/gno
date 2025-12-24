/**
 * Shared CLI command utilities.
 * Common initialization and formatting helpers.
 *
 * @module src/cli/commands/shared
 */

import { getIndexDbPath } from '../../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../../config';
import type { Collection, Config } from '../../config/types';
import type { SyncResult } from '../../ingestion';
import { SqliteAdapter } from '../../store/sqlite/adapter';

/**
 * Result of CLI store initialization.
 */
export type InitStoreResult =
  | {
      ok: true;
      store: SqliteAdapter;
      config: Config;
      collections: Collection[];
    }
  | { ok: false; error: string };

/**
 * Options for store initialization.
 */
export type InitStoreOptions = {
  /** Override config path */
  configPath?: string;
  /** Filter to single collection by name */
  collection?: string;
};

/**
 * Initialize store for CLI commands.
 * Handles: isInitialized check, loadConfig, DB open, syncCollections, syncContexts.
 *
 * Caller is responsible for calling store.close() when done.
 */
export async function initStore(
  options: InitStoreOptions = {}
): Promise<InitStoreResult> {
  // Check if initialized
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { ok: false, error: 'GNO not initialized. Run: gno init' };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { ok: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Filter to single collection if specified
  let collections = config.collections;
  if (options.collection) {
    collections = collections.filter((c) => c.name === options.collection);
    if (collections.length === 0) {
      return {
        ok: false,
        error: `Collection not found: ${options.collection}`,
      };
    }
  }

  if (collections.length === 0) {
    return {
      ok: false,
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
    return { ok: false, error: openResult.error.message };
  }

  // Sync collections from config to DB
  const syncCollResult = await store.syncCollections(config.collections);
  if (!syncCollResult.ok) {
    await store.close();
    return { ok: false, error: syncCollResult.error.message };
  }

  // Sync contexts from config to DB
  const syncCtxResult = await store.syncContexts(config.contexts ?? []);
  if (!syncCtxResult.ok) {
    await store.close();
    return { ok: false, error: syncCtxResult.error.message };
  }

  return { ok: true, store, config, collections };
}

/**
 * Format sync result lines (shared between update and index commands).
 */
export function formatSyncResultLines(
  syncResult: SyncResult,
  options: { verbose?: boolean }
): string[] {
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

  return lines;
}
