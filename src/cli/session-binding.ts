/**
 * CLI-wide enforcement of the session-archive config/index binding.
 *
 * Runs before every command and again whenever a command opens an index
 * (`initStore`, which also covers indexes named by a `?index=` URI): a config
 * bound to a session archive index cannot be used with another index, and an
 * archive index cannot be opened with a different config.
 *
 * @module src/cli/session-binding
 */

import type { Config } from "../config/types";

import { getIndexDbPath } from "../app/constants";
import { getConfigPaths, loadConfig } from "../config";
import { assertSessionBinding } from "../sessions/binding";
import { SessionsError } from "../sessions/types";
import { CliError } from "./errors";

export async function assertCliSessionBinding(
  configPath: string | undefined,
  indexName: string,
  loadedConfig?: Config
): Promise<void> {
  const path = configPath ?? getConfigPaths().configFile;
  let config = loadedConfig;
  if (!config) {
    if (!(await Bun.file(path).exists())) return;
    const loaded = await loadConfig(path);
    // Unreadable configs are reported by the command itself.
    if (!loaded.ok) return;
    config = loaded.value;
  }
  try {
    await assertSessionBinding({
      config,
      configPath: path,
      indexName,
      dbPath: getIndexDbPath(indexName),
    });
  } catch (error) {
    if (error instanceof SessionsError) {
      throw new CliError("VALIDATION", error.message, {
        details: { sessionsCode: error.code },
      });
    }
    throw error;
  }
}
