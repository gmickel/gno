/**
 * One collection flush: widen vanished exact paths, classify dirty hints,
 * targeted syncPaths, and config-generation full reconciliation.
 *
 * @module src/serve/watch-service-flush
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult, SyncOptions } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { WatcherSnapshot } from "./watch-snapshot";

import {
  collectionToWalkConfig,
  defaultSyncService,
  matchesWalkPath,
} from "../ingestion";
import {
  classifyDirtyHints,
  hasFileLevelSyncError,
  mergeSyncPathBatch,
  widenVanishedExactPaths,
} from "./watch-reconciliation";

export function changedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  if (result.files) {
    return result.files
      .filter((file) => file.status === "added" || file.status === "updated")
      .map((file) => file.relPath);
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
  previousSnapshot: WatcherSnapshot | null;
  syncGeneration: number;
  disposed: () => boolean;
  getCurrentCollection: () => Collection | undefined;
  getCurrentGeneration: () => number;
  onSyncStart: (relPaths: string[]) => void;
  onSyncComplete: (relPaths: string[], result: CollectionSyncResult) => void;
  onSyncError: (relPaths: string[], error: unknown) => void;
  onAfterSync: (collection: Collection, relPaths: string[]) => void;
  commitSnapshot: (snapshot: WatcherSnapshot) => void;
  invalidateSnapshot: (collection: Collection) => void;
  requeue: (exact: string[], dirty: string[]) => void;
}

export type FlushCollectionOutcome =
  | { status: "disposed" }
  | { status: "idle" }
  | { status: "synced" }
  | { status: "failed"; error?: unknown };

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

  try {
    const widened = await widenVanishedExactPaths(rootAbs, exactPaths);
    if (input.disposed()) {
      return { status: "disposed" };
    }
    const dirtyHints = [
      ...new Set([...input.dirtyTaken, ...widened.extraDirty]),
    ];

    let classifiedCandidates: string[] = [];
    let classifiedRemovals: string[] = [];
    let nextSnapshot: WatcherSnapshot | null = input.previousSnapshot;
    let dirtyFailed = false;

    if (dirtyHints.length > 0) {
      const classified = await classifyDirtyHints({
        collection: input.collection,
        store: input.store,
        rootAbs,
        previous: input.previousSnapshot,
        dirtyHints,
      });
      if (input.disposed()) {
        return { status: "disposed" };
      }
      if (classified.status === "error") {
        dirtyFailed = true;
        input.onSyncError(dirtyHints, classified.cause);
        input.requeue([], dirtyHints);
      } else {
        classifiedCandidates = classified.candidates;
        classifiedRemovals = classified.removals;
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

    if (relPaths.length === 0) {
      if (!dirtyFailed && nextSnapshot) {
        input.commitSnapshot(nextSnapshot);
      }
      return { status: "idle" };
    }

    input.onSyncStart(relPaths);
    let result = await defaultSyncService.syncPaths(
      input.collection,
      input.store,
      relPaths,
      {
        ...input.syncOptions,
        runUpdateCmd: false,
      }
    );
    if (input.disposed()) {
      return { status: "disposed" };
    }

    if (hasFileLevelSyncError(result)) {
      const error = new Error("One or more paths failed during watcher sync");
      input.onSyncError(relPaths, error);
      input.requeue(liveExact, dirtyFailed ? [] : dirtyHints);
      return { status: "failed", error };
    }

    if (!dirtyFailed && nextSnapshot) {
      input.commitSnapshot(nextSnapshot);
    }

    input.onSyncComplete(relPaths, result);

    let completionCollection = input.collection;
    let completionPaths = changedPaths(result, relPaths);
    let syncGeneration = input.syncGeneration;

    while (true) {
      const currentCollection = input.getCurrentCollection();
      if (!currentCollection) {
        break;
      }
      const currentGeneration = input.getCurrentGeneration();
      if (currentGeneration === syncGeneration) {
        const currentRelPaths =
          normalize(currentCollection.path) ===
          normalize(completionCollection.path)
            ? completionPaths.filter((relPath) =>
                matchesWalkPath(
                  relPath,
                  collectionToWalkConfig(currentCollection, 0)
                )
              )
            : [];
        if (currentRelPaths.length > 0) {
          input.onAfterSync(currentCollection, currentRelPaths);
        }
        break;
      }

      result = await defaultSyncService.syncCollection(
        currentCollection,
        input.store,
        {
          ...input.syncOptions,
          runUpdateCmd: false,
        }
      );
      if (input.disposed()) {
        return { status: "disposed" };
      }
      input.invalidateSnapshot(currentCollection);
      completionCollection = currentCollection;
      completionPaths = changedPaths(result);
      syncGeneration = currentGeneration;
      input.onSyncComplete(completionPaths, result);
    }

    return { status: "synced" };
  } catch (error) {
    if (input.disposed()) {
      return { status: "disposed" };
    }
    input.onSyncError(exactPaths, error);
    input.requeue(exactPaths, input.dirtyTaken);
    return { status: "failed", error };
  }
}
