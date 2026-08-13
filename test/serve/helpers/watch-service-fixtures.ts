/**
 * Shared fixtures for CollectionWatchService unit tests.
 */

import { afterEach } from "bun:test";

import type { Collection } from "../../../src/config/types";
import type { CollectionSyncResult } from "../../../src/ingestion";
import type { SqliteAdapter } from "../../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../../src/ingestion";

export function createCollection(
  name: string,
  path: string,
  overrides: Partial<Collection> = {}
): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    ...overrides,
  };
}

/** Minimal store seam so dirty fallback does not throw in unit tests. */
export function createStubStore(
  overrides: Partial<SqliteAdapter> = {}
): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
}

export function createSyncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);
const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);
const originalInactivateAbsentSources =
  defaultSyncService.inactivateAbsentSources.bind(defaultSyncService);

/** Restore defaultSyncService mocks after each test (call once per file). */
export function installWatchServiceSyncReset(): void {
  afterEach(() => {
    defaultSyncService.syncPaths = originalSyncPaths;
    defaultSyncService.syncCollection = originalSyncCollection;
    defaultSyncService.inactivateAbsentSources =
      originalInactivateAbsentSources;
  });
}
