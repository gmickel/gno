/**
 * Owned collection flush orchestration for CollectionWatchService.
 *
 * @module src/serve/watch-service-run-flush
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult, SyncOptions } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { WatchQueueHost } from "./watch-service-events";
import type { CollectionPending } from "./watch-service-state";
import type { WatcherSnapshot, WatcherSnapshotFs } from "./watch-snapshot";

import {
  requeueAfterFailure,
  requeueGenerationReconcile,
  startFlush,
} from "./watch-service-events";
import { flushCollectionOnce } from "./watch-service-flush";
import {
  emptyPending,
  pendingHasWork,
  takePending,
} from "./watch-service-state";

export interface RunFlushContext {
  collectionName: string;
  disposed: () => boolean;
  collections: () => Collection[];
  store: SqliteAdapter;
  syncOptions: () => SyncOptions;
  pendingByCollection: Map<string, CollectionPending>;
  flushDeadlineAt: Map<string, number>;
  syncing: Set<string>;
  retryScheduled: Set<string>;
  collectionGenerations: Map<string, number>;
  snapshots: Map<string, WatcherSnapshot>;
  snapshotReady: Map<string, boolean>;
  snapshotInit: Map<string, Promise<void>>;
  suppressedPaths: Map<string, number>;
  clock: () => number;
  queueHost: WatchQueueHost;
  callbacks: {
    onSyncStart?: (event: { collection: string; relPaths: string[] }) => void;
    onSyncComplete?: (event: {
      collection: string;
      relPaths: string[];
      result: CollectionSyncResult;
    }) => void;
    onSyncError?: (event: {
      collection: string;
      relPaths: string[];
      error: unknown;
    }) => void;
  } | null;
  onAfterSync: (collection: Collection, relPaths: string[]) => void;
  beginSnapshotInit: (collection: Collection) => void;
  clearLifecycleTombstones: (collectionName: string) => void;
  pruneSuppression: () => void;
  notifySettledIfIdle: () => void;
  /** Optional injectable FS for unsupported-handle / test seams. */
  snapshotFs?: WatcherSnapshotFs;
  /** Test seam: lower snapshot entry ceiling for overflow→full proofs. */
  snapshotEntryCeiling?: number;
}

/**
 * Drain one collection's pending work under a generation+root ownership token.
 */
export async function runOwnedCollectionFlush(
  ctx: RunFlushContext
): Promise<void> {
  const { collectionName } = ctx;
  if (ctx.disposed()) {
    return;
  }
  const pending = ctx.pendingByCollection.get(collectionName);
  if (!pendingHasWork(pending)) {
    ctx.flushDeadlineAt.delete(collectionName);
    return;
  }
  if (ctx.syncing.has(collectionName) || !pending) {
    return;
  }

  const collection = ctx
    .collections()
    .find((entry) => entry.name === collectionName);
  if (!collection) {
    ctx.pendingByCollection.delete(collectionName);
    ctx.flushDeadlineAt.delete(collectionName);
    return;
  }

  const taken = takePending(pending);
  ctx.pendingByCollection.set(collectionName, emptyPending());
  ctx.flushDeadlineAt.delete(collectionName);
  ctx.syncing.add(collectionName);

  const ownerGeneration = ctx.collectionGenerations.get(collectionName) ?? 0;
  const ownerRoot = normalize(collection.path);
  const stillOwner = (): boolean => {
    if (ctx.disposed()) {
      return false;
    }
    const current = ctx
      .collections()
      .find((entry) => entry.name === collectionName);
    return (
      current !== undefined &&
      (ctx.collectionGenerations.get(collectionName) ?? 0) ===
        ownerGeneration &&
      normalize(current.path) === ownerRoot
    );
  };

  try {
    const outcome = await flushCollectionOnce({
      collection,
      collectionName,
      store: ctx.store,
      syncOptions: ctx.syncOptions(),
      exactTaken: taken.exact,
      dirtyTaken: taken.dirty,
      forceFallback: taken.forceFallback,
      overflow: taken.overflow,
      generationReconcile: taken.generationReconcile,
      previousSnapshot: ctx.snapshots.get(collectionName) ?? null,
      ownerGeneration,
      ownerRoot,
      disposed: ctx.disposed,
      getCurrentCollection: () =>
        ctx.collections().find((entry) => entry.name === collectionName),
      getCurrentGeneration: () =>
        ctx.collectionGenerations.get(collectionName) ?? 0,
      getCurrentSyncOptions: ctx.syncOptions,
      clock: ctx.clock,
      suppressedPaths: ctx.suppressedPaths,
      snapshotFs: ctx.snapshotFs,
      snapshotEntryCeiling: ctx.snapshotEntryCeiling,
      onSyncStart: (relPaths) => {
        if (!stillOwner()) {
          return;
        }
        ctx.callbacks?.onSyncStart?.({
          collection: collection.name,
          relPaths,
        });
      },
      onSyncComplete: (relPaths, result) => {
        ctx.callbacks?.onSyncComplete?.({
          collection: collectionName,
          relPaths,
          result,
        });
      },
      onSyncError: (relPaths, error) => {
        ctx.callbacks?.onSyncError?.({
          collection: collectionName,
          relPaths,
          error,
        });
      },
      onAfterSync: ctx.onAfterSync,
      commitSnapshot: (snapshot) => {
        if (!stillOwner()) {
          return;
        }
        ctx.snapshots.set(collectionName, snapshot);
      },
      invalidateSnapshot: (current) => {
        const live = ctx
          .collections()
          .find((entry) => entry.name === collectionName);
        if (!live || normalize(live.path) !== normalize(current.path)) {
          return;
        }
        ctx.snapshots.delete(collectionName);
        ctx.snapshotReady.set(collectionName, false);
        ctx.snapshotInit.delete(collectionName);
        ctx.beginSnapshotInit(current);
      },
      requeue: (exact, dirty, forceFlags) => {
        if (!stillOwner()) {
          return;
        }
        requeueAfterFailure(
          ctx.queueHost,
          collectionName,
          exact,
          dirty,
          forceFlags
        );
      },
      requeueGeneration: () => {
        const live = ctx
          .collections()
          .find((entry) => entry.name === collectionName);
        if (!live) {
          return;
        }
        requeueGenerationReconcile(ctx.queueHost, collectionName);
      },
    });
    if (
      outcome.status === "failed" &&
      outcome.error &&
      !(
        outcome.error instanceof Error &&
        (outcome.error.message ===
          "One or more paths failed during watcher sync" ||
          outcome.error.message ===
            "One or more paths failed during watcher generation reconcile")
      )
    ) {
      throw outcome.error;
    }
  } finally {
    ctx.syncing.delete(collectionName);
    ctx.clearLifecycleTombstones(collectionName);
    ctx.pruneSuppression();
    if (!ctx.disposed()) {
      if (
        pendingHasWork(ctx.pendingByCollection.get(collectionName)) &&
        !ctx.retryScheduled.has(collectionName)
      ) {
        startFlush(ctx.queueHost, collectionName);
      } else if (!pendingHasWork(ctx.pendingByCollection.get(collectionName))) {
        ctx.notifySettledIfIdle();
      }
    }
  }
}
