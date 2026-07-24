/**
 * Config mutation helper shared by Web UI and MCP.
 *
 * @module src/core/config-mutation
 */

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import {
  formatConfigWarnings,
  loadConfig,
  normalizeConfigContentTypes,
  saveConfig,
} from "../config";
import { withWriteLock } from "./file-lock";

export interface ConfigMutationContext {
  store: SqliteAdapter;
  configPath?: string;
  /**
   * Optional first-run config factory. Callers must opt in explicitly; existing
   * mutation surfaces keep treating a missing config as an error.
   */
  createConfigIfMissing?: () => Config;
  onConfigUpdated: (config: Config) => void;
  /**
   * Optional cross-process serialization boundary. The in-memory mutex remains
   * authoritative within one process; callers sharing a config across
   * processes must additionally share this OS-backed lock path.
   */
  writeLockPath?: string;
  /**
   * Runs after the selected config is durably present and before store projection.
   * Setup recovery uses this boundary to persist a truthful resumable receipt.
   */
  afterConfigSaved?: (config: Config) => Promise<void> | void;
  /** Runs after config projection succeeds while the write lock is still held. */
  afterStoreSynced?: (config: Config) => Promise<void> | void;
}

export type MutationResult<T = void> =
  | { ok: true; config: Config; value?: T; skipSave?: boolean }
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

    const applyFreshConfigChange = async (): Promise<ApplyConfigResult<T>> => {
      const loadResult = await loadConfig(ctx.configPath);
      if (
        !loadResult.ok &&
        !(loadResult.error.code === "NOT_FOUND" && ctx.createConfigIfMissing)
      ) {
        return {
          ok: false,
          error: loadResult.error.message,
          code: "LOAD_ERROR",
        };
      }
      if (loadResult.ok) {
        for (const warning of formatConfigWarnings(loadResult.warnings)) {
          console.warn(warning);
        }
      }

      const currentConfig = loadResult.ok
        ? loadResult.value
        : ctx.createConfigIfMissing?.();
      if (!currentConfig) {
        return {
          ok: false,
          error: "Config file is missing",
          code: "LOAD_ERROR",
        };
      }
      const mutationResult = await mutate(currentConfig);
      if (!mutationResult.ok) {
        return {
          ok: false,
          error: mutationResult.error,
          code: mutationResult.code,
        };
      }

      const normalized = normalizeConfigContentTypes(mutationResult.config);
      for (const warning of formatConfigWarnings(normalized.warnings)) {
        console.warn(warning);
      }
      const newConfig = normalized.config;
      if (!mutationResult.skipSave) {
        const saveResult = await saveConfig(newConfig, ctx.configPath);
        if (!saveResult.ok) {
          return {
            ok: false,
            error: saveResult.error.message,
            code: "SAVE_ERROR",
          };
        }
      }

      await ctx.afterConfigSaved?.(newConfig);

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

      await ctx.afterStoreSynced?.(newConfig);
      ctx.onConfigUpdated(newConfig);

      return { ok: true, config: newConfig, value: mutationResult.value };
    };

    if (!ctx.writeLockPath) {
      return await applyFreshConfigChange();
    }
    try {
      return await withWriteLock(ctx.writeLockPath, applyFreshConfigChange);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LOCKED:")) {
        return { ok: false, error: error.message, code: "LOCKED" };
      }
      throw error;
    }
  } finally {
    resolveMutex();
  }
}
