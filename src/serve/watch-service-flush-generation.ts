/**
 * Config-generation / overflow / unsupported-FS full collection reconcile.
 *
 * @module src/serve/watch-service-flush-generation
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type {
  FlushCollectionInput,
  FlushCollectionOutcome,
} from "./watch-service-flush";

import { defaultSyncService } from "../ingestion";
import { hasFileLevelSyncError } from "./watch-reconciliation";
import {
  contentChangedPaths,
  notifyCompletedSync,
} from "./watch-service-flush-helpers";

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
        // Notify completed sync once; keep durable generation work.
        notifyCompletedSync(input, operationPaths, result, ownership);
        const error = new Error(
          "One or more paths failed during watcher generation reconcile"
        );
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
