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
  inspectPathPresence,
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
  WATCHER_MAX_RETRY_BACKOFF_MS,
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
  watcherRetryDelayMs,
  widenVanishedExactPaths,
  type ClassificationResult,
  type ExactPathKind,
  type PathPresence,
  type WatcherEventClassification,
} from "./watch-reconciliation-shared";

type StoreOnlyRemovals =
  | { status: "ok"; paths: string[] }
  | { status: "overflow" }
  | { status: "error"; cause: unknown };

/**
 * Store-known active paths under the dirty directory hints that are gone from
 * disk. The snapshot only knows what it scanned: a note indexed from its own
 * exact event after the baseline is in the store but not the snapshot, and
 * when its directory is then moved or replaced (one directory event) the
 * snapshot diff alone would leave it active (fn-209). A path the fresh
 * snapshot lists is present; any other is confirmed absent on disk before it
 * counts. A failed check never infers a delete.
 */
async function storeOnlyRemovals(options: {
  store: SqliteAdapter;
  collection: Collection;
  rootAbs: string;
  dirtyHints: readonly string[];
  next: WatcherSnapshot | null;
  sourcePathMax: number;
}): Promise<StoreOnlyRemovals> {
  const { store, collection, rootAbs, next, sourcePathMax } = options;
  if (typeof store.listActiveDescendantSourcePaths !== "function") {
    return { status: "ok", paths: [] };
  }
  const hints = [...new Set(options.dirtyHints)]
    .filter((hint) => hint !== "")
    .sort();
  // A hint under another hint is covered by the outer descendant lookup.
  const roots = hints.filter(
    (hint, index) =>
      !hints.slice(0, index).some((outer) => hint.startsWith(`${outer}/`))
  );
  const removals: string[] = [];
  let seen = 0;
  for (const dir of roots) {
    const listed = await store.listActiveDescendantSourcePaths(
      collection.name,
      dir,
      Math.max(1, sourcePathMax - seen)
    );
    if (!listed.ok) {
      if (listed.error.code === "OVERFLOW") return { status: "overflow" };
      // Not a directory path the store can scope (e.g. escapes the root).
      if (listed.error.code === "INVALID_INPUT") continue;
      return { status: "error", cause: new Error(listed.error.message) };
    }
    seen += listed.value.length;
    if (seen > sourcePathMax) return { status: "overflow" };
    for (const path of listed.value) {
      const slash = path.lastIndexOf("/");
      const parent = slash === -1 ? "" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (next?.directories.get(parent)?.has(name)) continue;
      const presence = await inspectPathPresence(rootAbs, path);
      if (presence.status === "missing") removals.push(path);
    }
  }
  return { status: "ok", paths: removals };
}

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
      const storeRemovals = await storeOnlyRemovals({
        store,
        collection,
        rootAbs,
        dirtyHints,
        next: diff.nextSnapshot,
        sourcePathMax,
      });
      if (storeRemovals.status === "overflow") {
        return { status: "full_reconcile", reason: "budget_overflow" };
      }
      if (storeRemovals.status === "error") {
        return {
          status: "error",
          cause: storeRemovals.cause,
          stage: "store",
        };
      }
      return {
        status: "ok",
        candidates: filterEligiblePaths(diff.candidates, collection),
        removals: filterEligiblePaths(
          [...new Set([...diff.removals, ...storeRemovals.paths])],
          collection
        ),
        nextSnapshot: diff.nextSnapshot,
        usedFallback: false,
      };
    }
    // Snapshot ceiling overflow cannot be repaired by re-diffing the same
    // dirty set — escalate to durable full-collection reconciliation.
    if (diff.status === "fallback" && diff.reason === "overflow") {
      return { status: "full_reconcile", reason: "snapshot_overflow" };
    }
    if (diff.status === "fallback" && diff.reason === "unproven_subtree") {
      return {
        status: "full_reconcile",
        reason: "snapshot_unproven_subtree",
      };
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
    directoryAvailability: snapshotOptions?.directoryAvailability,
  });
}
