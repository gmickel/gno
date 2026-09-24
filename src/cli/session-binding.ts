/**
 * CLI-wide enforcement of the session-archive config/index binding.
 *
 * Runs before every command: a config that is bound to a session archive
 * index cannot be used with another index, and an archive index cannot be
 * opened with a different config. Unrelated installs pay one small file read.
 *
 * @module src/cli/session-binding
 */

import { getIndexDbPath } from "../app/constants";
import { getConfigPaths, loadConfig } from "../config";
import { assertSessionBinding } from "../sessions/binding";
import { SessionsError } from "../sessions/types";
import { CliError } from "./errors";

export async function assertCliSessionBinding(
  configPath: string | undefined,
  indexName: string
): Promise<void> {
  const path = configPath ?? getConfigPaths().configFile;
  if (!(await Bun.file(path).exists())) return;
  const loaded = await loadConfig(path);
  // Unreadable configs are reported by the command itself.
  if (!loaded.ok) return;
  try {
    await assertSessionBinding({
      config: loaded.value,
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
