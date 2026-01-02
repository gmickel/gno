/**
 * Config mutation helper shared by Web UI and MCP.
 *
 * @module src/core/config-mutation
 */

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { loadConfig, saveConfig } from "../config";

export interface ConfigMutationContext {
  store: SqliteAdapter;
  configPath?: string;
  onConfigUpdated: (config: Config) => void;
}

export type MutationResult<T = void> =
  | { ok: true; config: Config; value?: T }
  | { ok: false; error: string; code: string };

export type ApplyConfigResult<T = void> =
  | { ok: true; config: Config; value?: T }
  | { ok: false; error: string; code: string };

/**
 * In-memory mutex for serializing config mutations.
 * Prevents lost updates when multiple requests try to modify config concurrently.
 */
let configMutex: Promise<void> = Promise.resolve();

export async function applyConfigChange<T = void>(
  ctx: ConfigMutationContext,
  mutate: (config: Config) => Promise<MutationResult<T>> | MutationResult<T>
): Promise<ApplyConfigResult<T>> {
  const previousMutex = configMutex;
  let resolveMutex: () => void = () => {
    /* no-op until assigned */
  };

  configMutex = new Promise((resolve) => {
    resolveMutex = resolve;
  });

  try {
    await previousMutex;

    const loadResult = await loadConfig(ctx.configPath);
    if (!loadResult.ok) {
      return {
        ok: false,
        error: loadResult.error.message,
        code: "LOAD_ERROR",
      };
    }

    const mutationResult = await mutate(loadResult.value);
    if (!mutationResult.ok) {
      return {
        ok: false,
        error: mutationResult.error,
        code: mutationResult.code,
      };
    }

    const newConfig = mutationResult.config;
    const saveResult = await saveConfig(newConfig, ctx.configPath);
    if (!saveResult.ok) {
      return {
        ok: false,
        error: saveResult.error.message,
        code: "SAVE_ERROR",
      };
    }

    const syncCollResult = await ctx.store.syncCollections(
      newConfig.collections
    );
    if (!syncCollResult.ok) {
      console.warn(
        `Config saved but DB sync failed: ${syncCollResult.error.message}`
      );
      return {
        ok: false,
        error: `DB sync failed: ${syncCollResult.error.message}`,
        code: "SYNC_ERROR",
      };
    }

    const syncCtxResult = await ctx.store.syncContexts(
      newConfig.contexts ?? []
    );
    if (!syncCtxResult.ok) {
      console.warn(
        `Config saved but context sync failed: ${syncCtxResult.error.message}`
      );
      return {
        ok: false,
        error: `Context sync failed: ${syncCtxResult.error.message}`,
        code: "SYNC_ERROR",
      };
    }

    ctx.onConfigUpdated(newConfig);

    return { ok: true, config: newConfig, value: mutationResult.value };
  } finally {
    resolveMutex();
  }
}
