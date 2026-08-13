/**
 * Exact/ambiguous watcher event classification and snapshot-backed reconcile.
 *
 * Snapshot fingerprints discover candidates only; exact eligible paths always
 * retain content-hash authority via targeted `syncPaths`.
 *
 * @module src/serve/watch-reconciliation
 */

import type { Collection } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";

import { WATCHER_ACTIVE_SOURCE_PATH_MAX } from "../store/types";
import { fallbackClassifyDirtyHints } from "./watch-reconciliation-fallback";
import {
  filterEligiblePaths,
  type ClassificationResult,
} from "./watch-reconciliation-shared";
import {
  reconcileWatcherHints,
  type WatcherSnapshot,
  type WatcherSnapshotOptions,
} from "./watch-snapshot";

export {
  WATCHER_FALLBACK_BUDGET,
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_MAX_DIRTY_HINTS,
  WATCHER_MAX_EXACT_PATHS,
  WATCHER_MAX_FLUSH_DELAY_MS,
  WATCHER_MAX_SUPPRESSION_ENTRIES,
  WATCHER_RETRY_BACKOFF_MS,
  addToCappedSet,
  classifyWatcherFilename,
  failedSyncPaths,
  filterEligiblePaths,
  hasFileLevelSyncError,
  inspectPathPresence,
  mergeSyncPathBatch,
  pruneSuppressionMap,
  successfulChangedPaths,
  widenVanishedExactPaths,
  type ClassificationResult,
  type ExactPathKind,
  type PathPresence,
  type WatcherEventClassification,
} from "./watch-reconciliation-shared";

/**
 * Snapshot-first classification of dirty hints. On overflow/scan/metadata
 * failure, uses bounded store + disk enumeration without inferring deletes
 * from failed queries.
 */
export async function classifyDirtyHints(options: {
  collection: Collection;
  store: SqliteAdapter;
  rootAbs: string;
  previous: WatcherSnapshot | null;
  dirtyHints: readonly string[];
  /**
   * When true (init-time ambiguous absorption risk), skip snapshot diff and use
   * bounded store/disk so present eligible finals always reach syncPaths.
   */
  forceFallback?: boolean;
  snapshotOptions?: WatcherSnapshotOptions;
  sourcePathMax?: number;
}): Promise<ClassificationResult> {
  const {
    collection,
    store,
    rootAbs,
    previous,
    dirtyHints,
    forceFallback = false,
    snapshotOptions,
    sourcePathMax = WATCHER_ACTIVE_SOURCE_PATH_MAX,
  } = options;

  if (dirtyHints.length === 0) {
    return {
      status: "ok",
      candidates: [],
      removals: [],
      nextSnapshot: previous,
      usedFallback: false,
    };
  }

  if (previous && !forceFallback) {
    const diff = await reconcileWatcherHints(
      rootAbs,
      previous,
      dirtyHints,
      snapshotOptions
    );
    if (diff.status === "ok") {
      return {
        status: "ok",
        candidates: filterEligiblePaths(diff.candidates, collection),
        removals: filterEligiblePaths(diff.removals, collection),
        nextSnapshot: diff.nextSnapshot,
        usedFallback: false,
      };
    }
    // Snapshot ceiling overflow cannot be repaired by re-diffing the same
    // dirty set — escalate to durable full-collection reconciliation.
    if (diff.status === "fallback" && diff.reason === "overflow") {
      return { status: "full_reconcile", reason: "snapshot_overflow" };
    }
    // Fall through for scan/metadata failure — previous snapshot uncommitted.
  }

  return fallbackClassifyDirtyHints({
    collection,
    store,
    rootAbs,
    dirtyHints,
    sourcePathMax,
    // Only anchored FS may walk; unsupported injects fail-closed handles.
    fs: snapshotOptions?.fs,
  });
}
