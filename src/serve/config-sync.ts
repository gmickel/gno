/**
 * Config synchronization utilities for the API server.
 * Ensures YAML config, DB tables, and in-memory context stay in sync.
 *
 * @module src/serve/config-sync
 */

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { ContextHolder } from "./routes/api";

import {
  applyConfigChange as applyConfigChangeCore,
  type ApplyConfigResult,
  type MutationResult,
} from "../core/config-mutation";

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
  return applyConfigChangeCore(
    {
      store,
      configPath,
      onConfigUpdated: (config) => {
        ctxHolder.config = config;
        ctxHolder.current = { ...ctxHolder.current, config };
      },
    },
    mutate
  );
}
