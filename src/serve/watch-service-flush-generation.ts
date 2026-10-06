/**
 * Config-generation / overflow / unsupported-FS full collection reconcile.
 *
 * @module src/serve/watch-service-flush-generation
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { CollectionSyncResult } from "../ingestion";
import type {
  FlushCollectionInput,
  FlushCollectionOutcome,
} from "./watch-service-flush";

import { defaultSyncService, isSourceAvailabilitySkip } from "../ingestion";
import { hasFileLevelSyncError } from "./watch-reconciliation";
import {
  contentChangedPaths,
  notifyCompletedSync,
} from "./watch-service-flush-helpers";

/** Failure codes from the store side of a sync: transient, worth a retry. */
const STORE_SIDE_FAILURE_CODES = new Set(["QUERY_FAILED", "STORE_ERROR"]);
const SOURCE_AVAILABILITY_PREFIX = "SOURCE_AVAILABILITY_";

interface ReconcileFailures {
  /** A collection-level failure (no path): the reconcile itself is incomplete. */
  unscoped: boolean;
  /** Every named failed path, from file receipts and walker errors alike. */
  named: string[];
  /** Named paths that failed in the store, not on the file's content. */
  storeSide: string[];
}

/** Classify the failures of a completed full-collection sync. */
function classifyReconcileFailures(
  result: CollectionSyncResult
): ReconcileFailures {
  const named = new Set<string>();
  const storeSide = new Set<string>();
  let unscoped = false;
  for (const file of result.files ?? []) {
    if (file.status !== "error") continue;
    named.add(file.relPath);
    if (STORE_SIDE_FAILURE_CODES.has(file.errorCode ?? ""))
      storeSide.add(file.relPath);
  }
  // A collection whose source availability cannot be proven fails the same
  // way on every attempt until its config or volume changes (a config edit
  // starts a new reconcile): record it once, like a content failure.
  let unavailable = false;
  // Walker failures (TOO_LARGE, PERMISSION...) appear only here.
  for (const entry of result.errors) {
    if (isSourceAvailabilitySkip(entry.code)) continue;
    if (!entry.relPath) {
      if (entry.code.startsWith(SOURCE_AVAILABILITY_PREFIX)) unavailable = true;
      else unscoped = true;
      continue;
    }
    named.add(entry.relPath);
    if (STORE_SIDE_FAILURE_CODES.has(entry.code)) storeSide.add(entry.relPath);
  }
  // A failure count with nothing named is collection-level too.
  if (named.size === 0 && !unavailable) unscoped = true;
  return { unscoped, named: [...named], storeSide: [...storeSide] };
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
export async function runGenerationReconcile(
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

      const ownership = {
        generation: currentGeneration,
        root: currentRoot,
      };
      // Operation scope: file receipts when present, else empty (full coll).
      const operationPaths =
        result.files?.map((file) => file.relPath) ??
        contentChangedPaths(result);

      if (hasFileLevelSyncError(result)) {
        const error = new Error(
          "One or more paths failed during watcher generation reconcile"
        );
        const failures = classifyReconcileFailures(result);
        // The walk completed: the collection is reconciled except for the
        // named failed paths (fn-211). Requeuing the whole generation
        // re-walked the collection every backoff step for as long as one file
        // kept failing. Store-side failures are transient and can leave a
        // stale document, so only those paths are retried (exact paths,
        // failure backoff). Content failures (unreadable, corrupt, too
        // large...) are recorded once, as `gno update` and the daemon's
        // initial sync do; the next edit to the file retries it. Keep the
        // whole generation when any failure is collection-level (e.g. the
        // document inventory failed) or this flush no longer owns the
        // collection (its requeue would be dropped).
        if (
          !failures.unscoped &&
          input.getCurrentGeneration() === input.ownerGeneration
        ) {
          input.invalidateSnapshot(stillCurrent);
          notifyCompletedSync(input, operationPaths, result, ownership);
          input.onSyncError(failures.named, error);
          if (failures.storeSide.length > 0) {
            input.requeue(failures.storeSide, []);
            return { status: "failed", error };
          }
          completedGeneration = currentGeneration;
          needsWork = input.getCurrentGeneration() !== completedGeneration;
          continue;
        }
        // Notify completed sync once; keep durable generation work.
        notifyCompletedSync(input, operationPaths, result, ownership);
        input.onSyncError([], error);
        input.requeueGeneration();
        return { status: "failed", error };
      }

      // Only after successful full reconcile: rebuild snapshot ownership.
      input.invalidateSnapshot(stillCurrent);
      notifyCompletedSync(input, operationPaths, result, ownership);
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
