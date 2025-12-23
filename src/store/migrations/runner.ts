/**
 * Database migration runner.
 * Tracks applied migrations in schema_meta table.
 *
 * @module src/store/migrations/runner
 */

import type { Database } from 'bun:sqlite';
import type { FtsTokenizer } from '../../config/types';
import type { MigrationResult, StoreResult } from '../types';
import { err, ok } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Migration definition */
export type Migration = {
  /** Version number (must be unique and sequential) */
  version: number;
  /** Human-readable name */
  name: string;
  /** Apply migration */
  up(db: Database, ftsTokenizer: FtsTokenizer): void;
  /** Rollback migration (optional) */
  down?(db: Database): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema Meta Queries
// ─────────────────────────────────────────────────────────────────────────────

const BOOTSTRAP_META_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

const GET_META = 'SELECT value FROM schema_meta WHERE key = ?';

const SET_META = `
  INSERT INTO schema_meta (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = datetime('now')
`;

// ─────────────────────────────────────────────────────────────────────────────
// Migration Runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get current schema version from database.
 * Returns 0 if no version is set.
 */
export function getSchemaVersion(db: Database): number {
  try {
    const row = db.query<{ value: string }, [string]>(GET_META).get('version');
    return row ? Number.parseInt(row.value, 10) : 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Get current FTS tokenizer from database.
 * Returns null if not set.
 */
export function getDbFtsTokenizer(db: Database): FtsTokenizer | null {
  try {
    const row = db
      .query<{ value: string }, [string]>(GET_META)
      .get('fts_tokenizer');
    return row ? (row.value as FtsTokenizer) : null;
  } catch {
    return null;
  }
}

/**
 * Set metadata value.
 */
function setMeta(db: Database, key: string, value: string): void {
  db.run(SET_META, [key, value]);
}

/**
 * Run pending migrations.
 *
 * @param db - Open database connection
 * @param migrations - Array of migrations to apply
 * @param ftsTokenizer - FTS tokenizer from config
 * @returns Migration result with applied versions
 */
export function runMigrations(
  db: Database,
  migrations: Migration[],
  ftsTokenizer: FtsTokenizer
): StoreResult<MigrationResult> {
  try {
    // Bootstrap schema_meta table
    db.exec(BOOTSTRAP_META_TABLE);

    // Get current version
    const currentVersion = getSchemaVersion(db);

    // Check FTS tokenizer consistency
    const dbTokenizer = getDbFtsTokenizer(db);
    if (dbTokenizer !== null && dbTokenizer !== ftsTokenizer) {
      // Tokenizer mismatch - this requires special handling
      // For now, we error out. EPIC 5 will handle FTS rebuild.
      return err(
        'MIGRATION_FAILED',
        `FTS tokenizer mismatch: DB has '${dbTokenizer}', config has '${ftsTokenizer}'. ` +
          'Run `gno index --rebuild-fts` to recreate FTS index with new tokenizer.'
      );
    }

    // Sort migrations by version
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    // Validate sequential versions
    for (let i = 0; i < sorted.length; i++) {
      const migration = sorted[i];
      if (migration && migration.version !== i + 1) {
        return err(
          'MIGRATION_FAILED',
          `Migration versions must be sequential. Expected ${i + 1}, got ${migration.version}`
        );
      }
    }

    // Filter pending migrations
    const pending = sorted.filter((m) => m.version > currentVersion);

    if (pending.length === 0) {
      return ok({
        applied: [],
        currentVersion,
        ftsTokenizer: dbTokenizer ?? ftsTokenizer,
      });
    }

    // Apply migrations in a transaction
    const applied: number[] = [];
    const transaction = db.transaction(() => {
      for (const migration of pending) {
        migration.up(db, ftsTokenizer);
        setMeta(db, 'version', migration.version.toString());
        applied.push(migration.version);
      }

      // Set FTS tokenizer if not already set
      if (dbTokenizer === null) {
        setMeta(db, 'fts_tokenizer', ftsTokenizer);
        setMeta(db, 'created_at', new Date().toISOString());
      }
    });

    transaction();

    return ok({
      applied,
      currentVersion: pending.at(-1)?.version ?? currentVersion,
      ftsTokenizer,
    });
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : 'Unknown migration error';
    return err('MIGRATION_FAILED', message, cause);
  }
}

/**
 * Check if FTS tokenizer change is needed.
 */
export function needsFtsRebuild(
  db: Database,
  configTokenizer: FtsTokenizer
): boolean {
  const dbTokenizer = getDbFtsTokenizer(db);
  return dbTokenizer !== null && dbTokenizer !== configTokenizer;
}
