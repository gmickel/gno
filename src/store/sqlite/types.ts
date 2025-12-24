/**
 * SQLite-specific types for raw DB access.
 * These are NOT part of StorePort contract - only used for vector layer.
 *
 * @module src/store/sqlite/types
 */

import type { Database } from 'bun:sqlite';

/**
 * Type guard interface for accessing raw SQLite DB.
 * Only implemented by SqliteAdapter, not part of StorePort contract.
 */
export type SqliteDbProvider = {
  getRawDb(): Database;
};

/**
 * Check if a store implements SqliteDbProvider.
 */
export function isSqliteDbProvider(store: unknown): store is SqliteDbProvider {
  return (
    store !== null &&
    typeof store === 'object' &&
    'getRawDb' in store &&
    typeof (store as SqliteDbProvider).getRawDb === 'function'
  );
}
