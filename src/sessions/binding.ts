/**
 * Archive config/index binding.
 *
 * A session archive is one dedicated config file paired with one named
 * index. The config side records the pair in `sessions.index`; the index side
 * records the canonical config path in `schema_meta`. Opening either half
 * with the wrong partner fails instead of silently pulling archive
 * collections into a curated index, or curated collections into the archive
 * index.
 *
 * @module src/sessions/binding
 */

import { Database } from "bun:sqlite";

// Configures the platform SQLite before any Database opens (macOS).
import "../store/sqlite/setup";
import type { Config } from "../config/types";

import { canonicalizeIndexName, isValidIndexName } from "../app/index-name";
import { canonicalOperationalPath } from "../core/config-write-lock";
import { SessionsError } from "./types";

/** `schema_meta` key naming the archive config an index is bound to. */
const SESSION_BINDING_META_KEY = "session_archive_config";

/**
 * Canonical identity of a config path: the same resolution the config writer
 * uses for its write target and lock. An existing file realpaths; a missing
 * one (init checks the binding before writing it) resolves through its
 * nearest existing ancestor, and a dangling symlink through its target, so
 * the marker matches the path the file later realpaths to (e.g. macOS `/var`
 * -> `/private/var`, Windows short or case variants).
 */
export function canonicalConfigPath(configPath: string): Promise<string> {
  return canonicalOperationalPath(configPath);
}

/** Read the binding marker of an index database without creating it. */
export function readIndexBinding(dbPath: string): string | null {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const table = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"
      )
      .get();
    if (!table) return null;
    const row = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM schema_meta WHERE key = ?"
      )
      .get(SESSION_BINDING_META_KEY);
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Record the archive binding on an index the caller already opened. */
export function writeIndexBinding(db: Database, configPath: string): void {
  db.run(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [SESSION_BINDING_META_KEY, configPath]
  );
}

function sameIndex(left: string, right: string): boolean {
  if (!(isValidIndexName(left) && isValidIndexName(right)))
    return left === right;
  return canonicalizeIndexName(left) === canonicalizeIndexName(right);
}

/**
 * Fail when the config/index pair contradicts a recorded archive binding.
 * `dbPath` may point to a database that does not exist yet.
 */
export async function assertSessionBinding(options: {
  config: Config;
  configPath: string;
  indexName: string;
  dbPath: string;
}): Promise<void> {
  const bound = options.config.sessions?.index;
  if (bound !== undefined && !sameIndex(bound, options.indexName)) {
    throw new SessionsError(
      "SESSIONS_BINDING_MISMATCH",
      `This config is a session archive config bound to index "${bound}", but index "${options.indexName}" was selected. Pass --index ${bound} together with this --config.`
    );
  }
  if (!(await Bun.file(options.dbPath).exists())) return;
  const marker = readIndexBinding(options.dbPath);
  if (marker === null) return;
  const configPath = await canonicalConfigPath(options.configPath);
  if (marker !== configPath) {
    throw new SessionsError(
      "SESSIONS_BINDING_MISMATCH",
      `Index "${options.indexName}" is a session archive bound to a different config file. Pass the archive's --config with --index ${options.indexName}; curated configs cannot open it.`
    );
  }
}
