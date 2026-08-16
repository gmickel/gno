/**
 * One collection flush: widen vanished exact paths, classify dirty hints,
 * proven-removal inactivation, targeted syncPaths, config-generation reconcile.
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
  createDirectoryAvailability,
  defaultSyncService,
  matchesWalkPath,
  memoizeDirectoryAvailability,
  resolveSourceAvailability,
} from "../ingestion";
import {
  classifyDirtyHints,
  failedSyncPaths,
  hasFileLevelSyncError,
  mergeSyncPathBatch,
  widenVanishedExactPaths,
} from "./watch-reconciliation";
import { runGenerationReconcile } from "./watch-service-flush-generation";
import {
  computeTargetedRetry,
  contentChangedPaths,
  notifyCompletedSync,
} from "./watch-service-flush-helpers";

/** @deprecated Prefer contentChangedPaths; kept for existing imports. */
export function changedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  return contentChangedPaths(result, fallbackPaths);
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
  /** Test seam: lower snapshot entry ceiling for overflow→full proofs. */
  snapshotEntryCeiling?: number;
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
    /** Ambiguous overflow/unsupported → durable full-collection authority. */
    let needsFullFromAmbiguous = false;

    if (dirtyHints.length > 0) {
      const availabilityMode = resolveSourceAvailability(
        input.collection,
        input.getCurrentSyncOptions()
      );
      const classified = await classifyDirtyHints({
        collection: input.collection,
        store: input.store,
        rootAbs,
        previous: input.previousSnapshot,
        dirtyHints,
        forceFallback,
        snapshotOptions: {
          ...(input.snapshotFs ? { fs: input.snapshotFs } : {}),
          ...(input.snapshotEntryCeiling !== undefined
            ? { entryCeiling: input.snapshotEntryCeiling }
            : {}),
          directoryAvailability: memoizeDirectoryAvailability(
            createDirectoryAvailability(availabilityMode)
          ),
        },
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
        // Classification failure: retain original dirty + force flags.
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
    // Present candidates only — proven removals use a distinct inactivation step.
    const presentPaths = mergeSyncPathBatch(
      liveExact,
      classifiedCandidates,
      []
    );
    const generationAuthority =
      needsFullFromAmbiguous || input.generationReconcile;
    const dirtyDerivedRemovals = classifiedRemovals.length > 0;
    const dirtyDerivedCandidates = classifiedCandidates.length > 0;

    let targetedSynced = false;
    let targetedFailed: { error: unknown } | null = null;
    /** Any dirty-derived candidate/removal op failed — block snapshot commit. */
    let dirtyDerivedFailed = dirtyFailed;

    // 1) Proven removals: inactivate even when path is now dir/FIFO/device.
    if (classifiedRemovals.length > 0) {
      if (!ownsTargeted(input)) {
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }
      input.onSyncStart(classifiedRemovals);
      const inactiveResult = await defaultSyncService.inactivateAbsentSources(
        input.collection,
        input.store,
        classifiedRemovals,
        {
          ...input.getCurrentSyncOptions(),
          runUpdateCmd: false,
        }
      );
      if (input.disposed()) {
        return { status: "disposed" };
      }
      if (!ownsTargeted(input)) {
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }

      const settled = new Set(
        notifyCompletedSync(input, classifiedRemovals, inactiveResult)
      );
      if (hasFileLevelSyncError(inactiveResult)) {
        dirtyDerivedFailed = true;
        const retry = computeTargetedRetry({
          result: inactiveResult,
          submittedPaths: classifiedRemovals,
          liveExact: [],
          settled,
          dirtyHints,
          dirtyFailed,
          dirtyDerivedSubmission: dirtyDerivedRemovals,
          generationAuthority,
        });
        // Failed proven removals re-enter as dirty so classification can retry.
        // Always retain original dirty hints + force flags on derived failure.
        const failedRemovals = classifiedRemovals.filter(
          (path) => !settled.has(path)
        );
        const error = new Error("One or more paths failed during watcher sync");
        input.onSyncError(
          failedRemovals.length > 0 ? failedRemovals : classifiedRemovals,
          error
        );
        input.requeue(
          retry.retryExact,
          [
            ...new Set([
              ...(retry.retainDirty || dirtyDerivedFailed ? dirtyHints : []),
              ...failedRemovals,
            ]),
          ],
          forceFlags
        );
        if (generationAuthority) {
          input.requeueGeneration();
        }
        // Still attempt present-path sync for eligible children of file→dir.
        targetedFailed = { error };
      } else {
        targetedSynced = true;
      }
    }

    // 2) Present exact + candidates: content-hash authority via syncPaths.
    if (presentPaths.length > 0) {
      if (!ownsTargeted(input)) {
        return (await runGenerationReconcile(input)) ?? { status: "stale" };
      }
      input.onSyncStart(presentPaths);
      const result = await defaultSyncService.syncPaths(
        input.collection,
        input.store,
        presentPaths,
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
        const settled = new Set(
          notifyCompletedSync(input, presentPaths, result)
        );
        const failed = failedSyncPaths(result, presentPaths).filter(
          (path) => !settled.has(path)
        );
        if (
          dirtyDerivedCandidates &&
          (result.errors.length > 0 ||
            result.filesErrored > 0 ||
            failed.some((path) => classifiedCandidates.includes(path)))
        ) {
          // Candidate batch failed — retain dirty authority, block snapshot.
          dirtyDerivedFailed = true;
        }
        const retry = computeTargetedRetry({
          result,
          submittedPaths: presentPaths,
          liveExact,
          settled,
          dirtyHints,
          dirtyFailed,
          dirtyDerivedSubmission: dirtyDerivedCandidates,
          generationAuthority,
        });
        const error = new Error("One or more paths failed during watcher sync");
        input.onSyncError(failed.length > 0 ? failed : retry.retryExact, error);
        // Retain original dirty hints + force flags — not solely failed exact.
        input.requeue(
          retry.retryExact,
          retry.retainDirty || dirtyDerivedFailed ? dirtyHints : [],
          forceFlags
        );
        if (generationAuthority) {
          input.requeueGeneration();
        }
        return { status: "failed", error };
      }

      // Commit only after full classified generation (candidates + removals).
      if (
        classificationOk &&
        !dirtyFailed &&
        !dirtyDerivedFailed &&
        !targetedFailed &&
        nextSnapshot
      ) {
        input.commitSnapshot(nextSnapshot);
      }

      notifyCompletedSync(input, presentPaths, result);
      targetedSynced = true;
    } else if (
      classificationOk &&
      !dirtyFailed &&
      !dirtyDerivedFailed &&
      !targetedFailed &&
      nextSnapshot &&
      ownsTargeted(input)
    ) {
      // Inactive-only / empty candidate classification: still commit snapshot.
      input.commitSnapshot(nextSnapshot);
      if (classifiedRemovals.length === 0 && !targetedSynced) {
        // No path op ran; classification-only settle is idle (no sync result).
      }
    }

    if (targetedFailed) {
      return { status: "failed", error: targetedFailed.error };
    }

    // Config-generation / overflow / unsupported-FS full reconciliation.
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
