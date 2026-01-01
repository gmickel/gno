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
  /** Error code - can be system codes or mutation-specific codes passed through */
  code: string;
}

export type ApplyConfigResult = ConfigSyncResult | ConfigSyncError;

export type MutationResult =
  | { ok: true; config: Config }
  | { ok: false; error: string; code: string };

/**
 * In-memory mutex for serializing config mutations.
 * Prevents lost updates when multiple requests try to modify config concurrently.
 */
let configMutex: Promise<void> = Promise.resolve();

/**
 * Apply a config mutation atomically with serialization.
 *
 * Sequence:
 * 1. Acquire mutex (serialize with other config mutations)
 * 2. Load current config from YAML
 * 3. Apply mutation function (receives fresh config)
 * 4. Save updated config to YAML (source of truth)
 * 5. Sync DB tables (collections, contexts)
 * 6. Update in-memory context holder (both config and current.config)
 *
 * If DB sync fails after YAML write, the error is returned but YAML remains
 * updated (it's the source of truth). Next server startup will re-sync.
 *
 * @param ctxHolder - Context holder with config and current ServerContext
 * @param store - Database adapter for syncing tables
 * @param mutate - Async mutation function that receives fresh-loaded config
 * @param configPath - Optional config path override (must match server's config)
 */
export async function applyConfigChange(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  mutate: (config: Config) => Promise<MutationResult> | MutationResult,
  configPath?: string
): Promise<ApplyConfigResult> {
  // Serialize config mutations to prevent lost updates
  const previousMutex = configMutex;
  let resolveMutex: () => void = () => {
    /* no-op until assigned */
  };
  configMutex = new Promise((resolve) => {
    resolveMutex = resolve;
  });

  try {
    await previousMutex;

    // 1. Load current config from YAML
    const loadResult = await loadConfig(configPath);
    if (!loadResult.ok) {
      return {
        ok: false,
        error: loadResult.error.message,
        code: 'LOAD_ERROR',
      };
    }

    // 2. Apply mutation to freshly-loaded config
    const mutationResult = await mutate(loadResult.value);
    if (!mutationResult.ok) {
      return {
        ok: false,
        error: mutationResult.error,
        code: mutationResult.code, // Pass through the original error code
      };
    }
    const newConfig = mutationResult.config;

    // 3. Save YAML atomically
    const saveResult = await saveConfig(newConfig, configPath);
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

    // 5. Update both in-memory references
    ctxHolder.config = newConfig;
    ctxHolder.current = { ...ctxHolder.current, config: newConfig };

    return { ok: true, config: newConfig };
  } finally {
    resolveMutex();
  }
}
