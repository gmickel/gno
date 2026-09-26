/**
 * Keep a running server's session-archive config current with its config
 * file. `gno sessions source add/remove` and automation changes rewrite the
 * file from another process; the REST routes and the MCP session tools both
 * re-read it here, binding checked, and adopt it only when it changed.
 *
 * @module src/sessions/config-refresh
 */

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { getIndexDbPath } from "../app/constants";
import { loadConfig } from "../config";
import { collectionEgressPolicyEpoch } from "../core/collection-egress-policy-service";
import { assertSessionBinding } from "./binding";
import { SessionsError } from "./types";

/** The config/index pair a server instance was opened on. */
export interface SessionsInstance {
  configPath: string;
  indexName: string;
}

/** A running server's served config and the hooks that follow a swap. */
export interface ServedSessionsConfig extends SessionsInstance {
  store: SqliteAdapter;
  config: Config;
  /** Swap the served config in memory (and anything derived from it). */
  setConfig: (config: Config) => void;
  invalidateEgressPolicy?: () => Promise<unknown>;
  markContentMutation?: () => void;
  markIndexMutation?: () => void;
}

/** Refuse an archive config opened against a different index (and vice versa). */
export async function assertInstanceBinding(
  instance: SessionsInstance,
  config: Config
): Promise<void> {
  if (!config.sessions) return;
  await assertSessionBinding({
    config,
    configPath: instance.configPath,
    indexName: instance.indexName,
    dbPath: getIndexDbPath(instance.indexName),
  });
}

/**
 * Read this instance's config file, binding checked: unreadable is an error,
 * never served stale, and a config rebound to another index is refused
 * before it can touch this one.
 */
export async function readInstanceConfig(
  instance: SessionsInstance
): Promise<Config> {
  const loaded = await loadConfig(instance.configPath);
  if (!loaded.ok) {
    throw new SessionsError(
      "SESSIONS_RUNTIME_FAILURE",
      "The server could not read its config file; fix the file (gno doctor shows the error) and reload."
    );
  }
  await assertInstanceBinding(instance, loaded.value);
  return loaded.value;
}

/**
 * Adopt a config already persisted to the file: project collections and
 * contexts into the open store, swap the served config, then refresh the
 * egress policy (only when it changed) and mutation generations.
 */
export async function adoptServedConfig(
  served: ServedSessionsConfig,
  config: Config
): Promise<void> {
  const collections = await served.store.syncCollections(config.collections);
  if (!collections.ok) {
    throw new Error(
      `Config saved but collection sync failed: ${collections.error.message}`
    );
  }
  const contexts = await served.store.syncContexts(config.contexts ?? []);
  if (!contexts.ok) {
    throw new Error(
      `Config saved but context sync failed: ${contexts.error.message}`
    );
  }
  const policyChanged =
    collectionEgressPolicyEpoch(config) !==
    collectionEgressPolicyEpoch(served.config);
  served.setConfig(config);
  if (policyChanged) await served.invalidateEgressPolicy?.();
  served.markContentMutation?.();
  served.markIndexMutation?.();
}

/**
 * Adopt the config file when it changed underneath the running server.
 * Returns the config to serve; throws a `SessionsError` when the file is
 * unreadable or bound to another index, leaving the served config as it was.
 */
export async function refreshServedConfig(
  served: ServedSessionsConfig
): Promise<Config> {
  const config = await readInstanceConfig(served);
  if (Bun.deepEquals(config, served.config)) return served.config;
  await adoptServedConfig(served, config);
  return config;
}
