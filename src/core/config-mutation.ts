/**
 * Canonical config mutation helper shared by every config writer.
 *
 * @module src/core/config-mutation
 */

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import {
  formatConfigWarnings,
  getConfigPaths,
  loadConfig,
  normalizeConfigContentTypes,
  saveConfig,
} from "../config";
import { resolveConfigWriteTarget } from "./config-write-lock";
import { withWriteLock } from "./file-lock";

export interface ConfigFileMutationContext {
  configPath?: string;
  /**
   * Optional first-run config factory. Callers must opt in explicitly; existing
   * mutation surfaces keep treating a missing config as an error.
   */
  createConfigIfMissing?: () => Config;
  onConfigUpdated?: (config: Config) => void;
}

export interface ConfigMutationContext extends ConfigFileMutationContext {
  store: SqliteAdapter;
  /**
   * Optional targeted store projection. The default reconciles the complete
   * config. Create/update-only callers can project a bounded subset without
   * deleting DB-only recovery state.
   */
  projectStore?: (
    store: SqliteAdapter,
    config: Config
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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

export interface ConfigMutationState {
  created: boolean;
}

type PersistedConfigHook = (
  config: Config
) => Promise<{ ok: true } | { ok: false; error: string; code: string }>;

async function applySerializedConfigChange<T>(
  ctx: ConfigFileMutationContext,
  mutate: (
    config: Config,
    state: ConfigMutationState
  ) => Promise<MutationResult<T>> | MutationResult<T>,
  afterPersist?: PersistedConfigHook
): Promise<ApplyConfigResult<T>> {
  const requestedConfigPath = ctx.configPath ?? getConfigPaths().configFile;
  const writeTarget = await resolveConfigWriteTarget(requestedConfigPath);
  const selectedConfigPath = writeTarget.configPath;
  const applyFreshConfigChange = async (): Promise<ApplyConfigResult<T>> => {
    const loadResult = await loadConfig(selectedConfigPath);
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
    const mutationResult = await mutate(currentConfig, {
      created: !loadResult.ok,
    });
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
      const saveResult = await saveConfig(newConfig, selectedConfigPath);
      if (!saveResult.ok) {
        return {
          ok: false,
          error: saveResult.error.message,
          code: "SAVE_ERROR",
        };
      }
    }

    const persisted = await afterPersist?.(newConfig);
    if (persisted && !persisted.ok) return persisted;
    ctx.onConfigUpdated?.(newConfig);

    return { ok: true, config: newConfig, value: mutationResult.value };
  };

  try {
    return await withWriteLock(writeTarget.lockPath, applyFreshConfigChange);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCKED:")) {
      return { ok: false, error: error.message, code: "LOCKED" };
    }
    throw error;
  }
}

/** Mutate only the selected config file under the canonical shared lock. */
export async function applyConfigFileChange<T = void>(
  ctx: ConfigFileMutationContext,
  mutate: (
    config: Config,
    state: ConfigMutationState
  ) => Promise<MutationResult<T>> | MutationResult<T>
): Promise<ApplyConfigResult<T>> {
  return applySerializedConfigChange(ctx, mutate);
}

/** Mutate config and project it to the selected store in one locked boundary. */
export async function applyConfigChange<T = void>(
  ctx: ConfigMutationContext,
  mutate: (
    config: Config,
    state: ConfigMutationState
  ) => Promise<MutationResult<T>> | MutationResult<T>
): Promise<ApplyConfigResult<T>> {
  return applySerializedConfigChange(ctx, mutate, async (newConfig) => {
    await ctx.afterConfigSaved?.(newConfig);

    if (ctx.projectStore) {
      const projection = await ctx.projectStore(ctx.store, newConfig);
      if (!projection.ok) {
        console.warn(`Config saved but DB sync failed: ${projection.error}`);
        return {
          ok: false,
          error: `DB sync failed: ${projection.error}`,
          code: "SYNC_ERROR",
        };
      }
    } else {
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
    }

    await ctx.afterStoreSynced?.(newConfig);
    return { ok: true };
  });
}
