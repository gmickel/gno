/**
 * Config synchronization utilities for the API server.
 * Ensures YAML config, DB tables, and in-memory context stay in sync.
 *
 * @module src/serve/config-sync
 */

import { loadConfig, saveConfig } from '../config';
import type { Config } from '../config/types';
import type { SqliteAdapter } from '../store/sqlite/adapter';
import type { ContextHolder } from './routes/api';

export interface ConfigSyncResult {
  ok: true;
  config: Config;
}

export interface ConfigSyncError {
  ok: false;
  error: string;
  code: 'LOAD_ERROR' | 'SAVE_ERROR' | 'SYNC_ERROR';
}

export type ApplyConfigResult = ConfigSyncResult | ConfigSyncError;

/**
 * Apply a config mutation atomically.
 *
 * Sequence:
 * 1. Load current config from YAML
 * 2. Apply mutation function
 * 3. Save updated config to YAML (source of truth)
 * 4. Sync DB tables (collections, contexts)
 * 5. Update in-memory context holder
 *
 * If DB sync fails after YAML write, the error is returned but YAML remains
 * updated (it's the source of truth). Next server startup will re-sync.
 */
export async function applyConfigChange(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  mutate: (config: Config) => Config
): Promise<ApplyConfigResult> {
  // 1. Load current config
  const loadResult = await loadConfig();
  if (!loadResult.ok) {
    return {
      ok: false,
      error: loadResult.error.message,
      code: 'LOAD_ERROR',
    };
  }

  // 2. Apply mutation
  const newConfig = mutate(loadResult.value);

  // 3. Save YAML atomically
  const saveResult = await saveConfig(newConfig);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: saveResult.error.message,
      code: 'SAVE_ERROR',
    };
  }

  // 4. Sync DB tables
  const syncCollResult = await store.syncCollections(newConfig.collections);
  if (!syncCollResult.ok) {
    // YAML is saved, but DB sync failed - log warning
    console.warn(
      `Config saved but DB sync failed: ${syncCollResult.error.message}`
    );
    return {
      ok: false,
      error: `DB sync failed: ${syncCollResult.error.message}`,
      code: 'SYNC_ERROR',
    };
  }

  const syncCtxResult = await store.syncContexts(newConfig.contexts ?? []);
  if (!syncCtxResult.ok) {
    console.warn(
      `Config saved but context sync failed: ${syncCtxResult.error.message}`
    );
    return {
      ok: false,
      error: `Context sync failed: ${syncCtxResult.error.message}`,
      code: 'SYNC_ERROR',
    };
  }

  // 5. Update in-memory context
  ctxHolder.config = newConfig;

  return { ok: true, config: newConfig };
}
