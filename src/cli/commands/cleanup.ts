/**
 * gno cleanup command implementation.
 * Remove documents of collections no longer configured, then orphaned
 * content, chunks and vectors not referenced by active documents.
 *
 * @module src/cli/commands/cleanup
 */

import type { CleanupStats, StaleCollection } from "../../store/types";

import { getIndexDbPath } from "../../app/constants";
import { isInitialized, loadConfig } from "../../config";
import { SqliteAdapter } from "../../store/sqlite/adapter";

/**
 * Options for cleanup command.
 */
export interface CleanupOptions {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
}

/**
 * Result of cleanup command.
 */
export type CleanupResult =
  | {
      success: true;
      stats: CleanupStats;
      /** Indexed collections the config omits, deleted by this cleanup. */
      droppedCollections: StaleCollection[];
    }
  | { success: false; error: string };

/**
 * Execute gno cleanup command.
 */
export async function cleanup(
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  // Check if initialized
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: "GNO not initialized. Run: gno init" };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Open database
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath(options.indexName);

  const openResult = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  try {
    // Drop collections no longer in the config first (their documents follow
    // by cascade), so their content, chunks and vectors count as orphans.
    // This is the explicit removal path; it names what it deletes.
    const stale = await store.listStaleCollections(
      config.collections.map(({ name }) => name)
    );
    if (!stale.ok) {
      return { success: false, error: stale.error.message };
    }
    const droppedCollections = stale.value.filter((c) => c.documents > 0);
    const syncResult = await store.syncCollections(config.collections, {
      remove: droppedCollections.map(({ name }) => name),
    });
    if (!syncResult.ok) {
      return { success: false, error: syncResult.error.message };
    }

    const cleanupResult = await store.cleanupOrphans();
    if (!cleanupResult.ok) {
      return { success: false, error: cleanupResult.error.message };
    }

    return { success: true, stats: cleanupResult.value, droppedCollections };
  } finally {
    await store.close();
  }
}

/**
 * Format cleanup result for output.
 */
export function formatCleanup(result: CleanupResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const { stats, droppedCollections } = result;
  const total =
    stats.orphanedContent +
    stats.orphanedChunks +
    stats.orphanedVectors +
    stats.expiredCache;
  const dropped = droppedCollections.map(
    (c) =>
      `  ${c.name}: ${c.documents} ${c.documents === 1 ? "document" : "documents"}`
  );
  const droppedLines = dropped.length
    ? ["Deleted collections not in this config:", ...dropped]
    : [];

  if (total === 0) {
    return [...droppedLines, "No orphans found. Index is clean."].join("\n");
  }

  const lines: string[] = [...droppedLines, "Cleanup complete:"];

  if (stats.orphanedContent > 0) {
    lines.push(`  Orphaned content: ${stats.orphanedContent}`);
  }
  if (stats.orphanedChunks > 0) {
    lines.push(`  Orphaned chunks: ${stats.orphanedChunks}`);
  }
  if (stats.orphanedVectors > 0) {
    lines.push(`  Orphaned vectors: ${stats.orphanedVectors}`);
  }
  if (stats.expiredCache > 0) {
    lines.push(`  Expired cache: ${stats.expiredCache}`);
  }

  lines.push(`Total removed: ${total}`);

  return lines.join("\n");
}
