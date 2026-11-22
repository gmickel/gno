/**
 * Per-invocation CLI config and session-binding cache.
 *
 * Eliminates 2x-3x redundant YAML/Zod parses across preAction session-binding,
 * initStore, and terminal-link policy within a single CLI command while staying
 * completely inactive for direct non-CLI callers and invalidating immediately
 * on config writes or resetGlobals().
 *
 * @module src/cli/config-cache
 */

import type { LoadResult } from "../config/loader";
import type { Config } from "../config/types";

import { expandPath, getConfigPaths } from "../config/paths";
import { getConfigWriteGeneration } from "../config/saver";
import { isCliInvocationActive, registerGlobalsResetListener } from "./globals";

type LoadConfigResult = LoadResult<Config>;

interface CachedConfigEntry {
  generation: number;
  result: LoadConfigResult;
}

const configCache = new Map<string, CachedConfigEntry>();
const verifiedBindings = new Map<string, number>();

export function clearCliConfigCache(): void {
  configCache.clear();
  verifiedBindings.clear();
}

registerGlobalsResetListener(clearCliConfigCache);

function resolveCanonicalConfigPath(configPath?: string): string {
  return configPath ? expandPath(configPath) : getConfigPaths().configFile;
}

/**
 * Load config, reusing a parsed result within the same CLI invocation when
 * no config write has occurred since it was loaded.
 */
export async function loadConfigCached(
  configPath?: string
): Promise<LoadConfigResult> {
  const { loadConfig } = await import("../config/loader");
  if (!isCliInvocationActive()) {
    return loadConfig(configPath);
  }
  const canonical = resolveCanonicalConfigPath(configPath);
  const generation = getConfigWriteGeneration();
  const cached = configCache.get(canonical);
  if (cached && cached.generation === generation) {
    return cached.result;
  }
  const loaded = await loadConfig(configPath);
  if (loaded.ok && getConfigWriteGeneration() === generation) {
    configCache.set(canonical, { generation, result: loaded });
  }
  return loaded;
}

/** Check whether a (configPath, indexName) binding was already verified in this CLI invocation. */
export function isSessionBindingVerifiedInInvocation(
  configPath: string,
  indexName: string
): boolean {
  if (!isCliInvocationActive()) {
    return false;
  }
  const key = `${resolveCanonicalConfigPath(configPath)}\u0000${indexName}`;
  return verifiedBindings.get(key) === getConfigWriteGeneration();
}

/** Record that (configPath, indexName) passed session-binding verification in this CLI invocation. */
export function markSessionBindingVerifiedInInvocation(
  configPath: string,
  indexName: string
): void {
  if (!isCliInvocationActive()) {
    return;
  }
  const key = `${resolveCanonicalConfigPath(configPath)}\u0000${indexName}`;
  verifiedBindings.set(key, getConfigWriteGeneration());
}
