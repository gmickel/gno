/**
 * One collection flush: widen vanished exact paths, classify dirty hints,
 * targeted syncPaths, and config-generation full reconciliation.
 *
 * @module src/serve/watch-service-flush
 */

// node:path — Bun has no path utilities
import { join, normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult, SyncOptions } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { PendingForceFlags } from "./watch-service-state";
import type { WatcherSnapshot, WatcherSnapshotFs } from "./watch-snapshot";

import {
  collectionToWalkConfig,
  defaultSyncService,
  matchesWalkPath,
} from "../ingestion";
import {
  classifyDirtyHints,
  failedSyncPaths,
  hasFileLevelSyncError,
  mergeSyncPathBatch,
  successfulChangedPaths,
  widenVanishedExactPaths,
} from "./watch-reconciliation";

export function changedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  const fromFiles = successfulChangedPaths(result);
  if (result.files) {
    return fromFiles;
  }
  return result.filesAdded + result.filesUpdated + result.filesMarkedInactive >
    0
    ? fallbackPaths
    : [];
}

export interface FlushCollectionInput {
  collection: Collection;
  collectionName: string;
  store: SqliteAdapter;
  syncOptions: SyncOptions;
  exactTaken: string[];
  dirtyTaken: string[];
  forceFallback: boolean;
  overflow: boolean;
  generationReconcile: boolean;
  previousSnapshot: WatcherSnapshot | null;
  /** Ownership token: generation + normalized root at flush start. */
  ownerGeneration: number;
  ownerRoot: string;
  disposed: () => boolean;
  getCurrentCollection: () => Collection | undefined;
  getCurrentGeneration: () => number;
  getCurrentSyncOptions: () => SyncOptions;
  clock: () => number;
  suppressedPaths: Map<string, number>;
  /** Optional injectable FS (tests: unsupported-handle proofs). */
  snapshotFs?: WatcherSnapshotFs;
  onSyncStart: (relPaths: string[]) => void;
  onSyncComplete: (relPaths: string[], result: CollectionSyncResult) => void;
  onSyncError: (relPaths: string[], error: unknown) => void;
  onAfterSync: (collection: Collection, relPaths: string[]) => void;
  commitSnapshot: (snapshot: WatcherSnapshot) => void;
  invalidateSnapshot: (collection: Collection) => void;
  requeue: (
    exact: string[],
    dirty: string[],
    forceFlags?: PendingForceFlags
  ) => void;
  requeueGeneration: () => void;
}

export type FlushCollectionOutcome =
  | { status: "disposed" }
  | { status: "idle" }
  | { status: "synced" }
  | { status: "failed"; error?: unknown }
  | { status: "stale" };

function filterSuppressedPaths(
  rootAbs: string,
  paths: readonly string[],
  suppressed: Map<string, number>,
  nowMs: number
): string[] {
  return paths.filter((relPath) => {
    const abs = normalize(join(rootAbs, ...relPath.split("/").filter(Boolean)));
    const until = suppressed.get(abs);
    return !(until && until > nowMs);
  });
}

/**
 * Targeted work ownership: same generation and normalized root as flush start.
 * Generation-reconcile work is separate and may intentionally run after a gen bump.
 */
function ownsTargeted(input: FlushCollectionInput): boolean {
  if (input.disposed()) {
    return false;
  }
  const current = input.getCurrentCollection();
  if (!current) {
    return false;
  }
  return (
    input.getCurrentGeneration() === input.ownerGeneration &&
    normalize(current.path) === input.ownerRoot
  );
}

/**
 * Settle successful paths once. onSyncComplete may synchronously replace
 * collection/root — reacquire ownership before onAfterSync/scheduler/events.
 * Never bypass ownership (including generation reconcile callers).
 */
function notifySuccessfulChanges(
  input: FlushCollectionInput,
  result: CollectionSyncResult,
  fallbackPaths: string[] = [],
  ownership?: { generation: number; root: string }
): string[] {
  const paths = changedPaths(result, fallbackPaths);
  if (paths.length === 0) {
    return [];
  }
  input.onSyncComplete(paths, result);
  if (input.disposed()) {
    return paths;
  }
  const currentCollection = input.getCurrentCollection();
  if (!currentCollection) {
    return paths;
  }
  const expectedGen = ownership?.generation ?? input.ownerGeneration;
  const expectedRoot = ownership?.root ?? input.ownerRoot;
  if (
    input.getCurrentGeneration() !== expectedGen ||
    normalize(currentCollection.path) !== expectedRoot
  ) {
    return paths;
  }
  const filtered = paths.filter((relPath) =>
    matchesWalkPath(relPath, collectionToWalkConfig(currentCollection, 0))
  );
  if (filtered.length > 0) {
    input.onAfterSync(currentCollection, filtered);
  }
  return paths;
}

/**
 * Run one flush attempt. Caller owns syncing flags and settlement.
 */
export async function flushCollectionOnce(
  input: FlushCollectionInput
): Promise<FlushCollectionOutcome> {
  const walkConfig = collectionToWalkConfig(input.collection, 0);
  const exactPaths = input.exactTaken.filter((relPath) =>
    matchesWalkPath(relPath, walkConfig)
  );
  const rootAbs = normalize(input.collection.path);
  const forceFlags: PendingForceFlags = {
    forceFallback: input.forceFallback || input.overflow,
    overflow: input.overflow,
  };

  try {
    if (input.disposed()) {
      return { status: "disposed" };
    }
    // Collection gone: drop taken work; do not mutate successor state.
    if (!input.getCurrentCollection()) {
      return { status: "stale" };
    }

    const widened = await widenVanishedExactPaths(rootAbs, exactPaths);
    if (input.disposed()) {
      return { status: "disposed" };
    }
    if (!ownsTargeted(input)) {
      // Root/config replaced mid-flight: still attempt generation reconcile.
      return (await runGenerationReconcile(input)) ?? { status: "stale" };
    }

    const dirtyHints = [
      ...new Set([...input.dirtyTaken, ...widened.extraDirty]),
    ];
    // Directory exact paths and init-time ambiguous work need store/disk so
    // present eligible children/finals are not absorbed by an unchanged baseline.
    const forceFallback =
      forceFlags.forceFallback || widened.directoryDirty.length > 0;
    if (widened.directoryDirty.length > 0) {
      forceFlags.forceFallback = true;
    }

    let classifiedCandidates: string[] = [];
    let classifiedRemovals: string[] = [];
    let nextSnapshot: WatcherSnapshot | null = input.previousSnapshot;
    let dirtyFailed = false;
    let classificationOk = dirtyHints.length === 0;
    /** Ambiguous work on unsupported FS → durable full-collection authority. */
    let needsFullFromAmbiguous = false;

    if (dirtyHints.length > 0) {
      const classified = await classifyDirtyHints({
        collection: input.collection,
        store: input.store,
        rootAbs,
        previous: input.previousSnapshot,
        dirtyHints,
        forceFallback,
        snapshotOptions: input.snapshotFs
          ? { fs: input.snapshotFs }
          : undefined,
      });
      if (input.disposed()) {
        return { status: "disposed" };
      }
      if (!ownsTargeted(input)) {
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }
      if (classified.status === "full_reconcile") {
        // No path-backed scan; convert ambiguous work to durable full sync.
        needsFullFromAmbiguous = true;
        classificationOk = false;
        nextSnapshot = null;
      } else if (classified.status === "error") {
        dirtyFailed = true;
        input.onSyncError(dirtyHints, classified.cause);
        input.requeue([], dirtyHints, forceFlags);
      } else {
        classificationOk = true;
        const nowMs = input.clock();
        // After successful dirty classification, drop suppressed abs paths
        // before batching; snapshot generation may still commit.
        classifiedCandidates = filterSuppressedPaths(
          rootAbs,
          classified.candidates,
          input.suppressedPaths,
          nowMs
        );
        classifiedRemovals = filterSuppressedPaths(
          rootAbs,
          classified.removals,
          input.suppressedPaths,
          nowMs
        );
        nextSnapshot = classified.nextSnapshot;
      }
    }

    const liveExact = widened.keepExact.filter((relPath) =>
      matchesWalkPath(relPath, walkConfig)
    );
    const relPaths = mergeSyncPathBatch(
      liveExact,
      classifiedCandidates,
      classifiedRemovals
    );

    let targetedSynced = false;
    if (relPaths.length > 0) {
      if (!ownsTargeted(input)) {
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }
      input.onSyncStart(relPaths);
      const result = await defaultSyncService.syncPaths(
        input.collection,
        input.store,
        relPaths,
        {
          ...input.getCurrentSyncOptions(),
          runUpdateCmd: false,
        }
      );
      if (input.disposed()) {
        return { status: "disposed" };
      }

      if (!ownsTargeted(input)) {
        // Do not commit/requeue/callback for the old owner; gen reconcile may run.
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }

      if (hasFileLevelSyncError(result)) {
        // Partial success: settle only successful changed paths; retain failures.
        const settled = new Set(notifySuccessfulChanges(input, result));
        const failed = failedSyncPaths(result, relPaths).filter(
          (path) => !settled.has(path)
        );
        const error = new Error("One or more paths failed during watcher sync");
        input.onSyncError(failed.length > 0 ? failed : relPaths, error);
        // Top-level errors (e.g. EDGE_FAIL) with successful files: do not drain
        // originating dirty hints; successful paths settle exactly once.
        const topLevelErrors = result.errors.length > 0;
        const retryExact =
          failed.length > 0
            ? failed
            : liveExact.filter((path) => !settled.has(path));
        const retainDirty =
          dirtyFailed || (topLevelErrors && dirtyHints.length > 0);
        input.requeue(retryExact, retainDirty ? dirtyHints : [], forceFlags);
        // Withhold snapshot commit on any file-level / top-level failure.
        if (needsFullFromAmbiguous || input.generationReconcile) {
          input.requeueGeneration();
        }
        return { status: "failed", error };
      }

      if (classificationOk && !dirtyFailed && nextSnapshot) {
        input.commitSnapshot(nextSnapshot);
      }

      notifySuccessfulChanges(input, result, relPaths);
      targetedSynced = true;
    } else if (
      classificationOk &&
      !dirtyFailed &&
      nextSnapshot &&
      ownsTargeted(input)
    ) {
      input.commitSnapshot(nextSnapshot);
    }

    // Config-generation / unsupported-FS full reconciliation: durable until success.
    const genInput: FlushCollectionInput = needsFullFromAmbiguous
      ? { ...input, generationReconcile: true }
      : input;
    const genOutcome = await runGenerationReconcile(genInput);
    if (genOutcome) {
      return genOutcome;
    }

    return targetedSynced || input.generationReconcile || needsFullFromAmbiguous
      ? { status: "synced" }
      : { status: "idle" };
  } catch (error) {
    if (input.disposed()) {
      return { status: "disposed" };
    }
    if (!ownsTargeted(input)) {
      return (await runGenerationReconcile(input)) ?? { status: "stale" };
    }
    input.onSyncError(exactPaths, error);
    input.requeue(exactPaths, input.dirtyTaken, forceFlags);
    if (input.generationReconcile) {
      input.requeueGeneration();
    }
    return { status: "failed", error };
  }
}

/**
 * When collection generation advanced during/before flush, run full
 * syncCollection. Failures leave durable generation work and never advance
 * snapshot ownership. Options are read fresh each iteration.
 *
 * If generation/root/options change again after a completed syncCollection,
 * continue with the latest collection/options rather than returning stale with
 * empty pending.
 */
async function runGenerationReconcile(
  input: FlushCollectionInput
): Promise<FlushCollectionOutcome | null> {
  let completedGeneration: number | null = null;
  let needsWork =
    input.generationReconcile ||
    input.getCurrentGeneration() !== input.ownerGeneration;

  while (needsWork) {
    const currentCollection = input.getCurrentCollection();
    if (!currentCollection) {
      return { status: "stale" };
    }
    const currentGeneration = input.getCurrentGeneration();
    const currentRoot = normalize(currentCollection.path);

    // Already reconciled this generation and nothing newer is pending.
    if (
      completedGeneration !== null &&
      completedGeneration === currentGeneration
    ) {
      return null;
    }

    try {
      // Always use live options — content rules may change mid-generation.
      const result = await defaultSyncService.syncCollection(
        currentCollection,
        input.store,
        {
          ...input.getCurrentSyncOptions(),
          runUpdateCmd: false,
        }
      );
      if (input.disposed()) {
        return { status: "disposed" };
      }

      const stillCurrent = input.getCurrentCollection();
      if (!stillCurrent) {
        return { status: "stale" };
      }
      const latestGen = input.getCurrentGeneration();
      const latestRoot = normalize(stillCurrent.path);

      // Root replaced mid-reconcile: durable requeue for the new owner.
      if (latestRoot !== currentRoot) {
        input.requeueGeneration();
        return { status: "stale" };
      }

      // Generation advanced during syncCollection: continue with latest, no
      // intermediate snapshot/callback commit for the superseded generation.
      if (latestGen !== currentGeneration) {
        needsWork = true;
        continue;
      }

      if (hasFileLevelSyncError(result)) {
        // Notify only successful changed paths; keep durable generation work.
        // Reacquire ownership after onSyncComplete (may replace root/config).
        notifySuccessfulChanges(input, result, [], {
          generation: currentGeneration,
          root: currentRoot,
        });
        const error = new Error(
          "One or more paths failed during watcher generation reconcile"
        );
        input.onSyncError([], error);
        input.requeueGeneration();
        return { status: "failed", error };
      }

      // Only after successful full reconcile: rebuild snapshot ownership.
      input.invalidateSnapshot(stillCurrent);
      // Reacquire after any side effects; never emit old-owner afterSync.
      notifySuccessfulChanges(input, result, [], {
        generation: currentGeneration,
        root: currentRoot,
      });
      completedGeneration = currentGeneration;
      needsWork = input.getCurrentGeneration() !== completedGeneration;
    } catch (error) {
      if (input.disposed()) {
        return { status: "disposed" };
      }
      const stillCurrent = input.getCurrentCollection();
      if (!stillCurrent) {
        return { status: "stale" };
      }
      const latestGen = input.getCurrentGeneration();
      const latestRoot = normalize(stillCurrent.path);
      if (latestRoot !== currentRoot) {
        input.requeueGeneration();
        return { status: "stale" };
      }
      // Gen advanced under a thrown reconcile: continue toward latest rather
      // than return stale with empty pending.
      if (latestGen !== currentGeneration) {
        needsWork = true;
        continue;
      }
      input.onSyncError([], error);
      input.requeueGeneration();
      return { status: "failed", error };
    }
  }
  return null;
}
