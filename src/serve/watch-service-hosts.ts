/**
 * Host object builders for CollectionWatchService collaborators.
 *
 * @module src/serve/watch-service-hosts
 */

import type { FSWatcher } from "node:fs";

import type { Collection } from "../config/types";
import type { SyncOptions } from "../ingestion";
import type { WatchEventHost, WatchQueueHost } from "./watch-service-events";
import type { WatchLifecycleHost } from "./watch-service-lifecycle";
import type { CollectionPending } from "./watch-service-state";
import type { WatcherSnapshot } from "./watch-snapshot";

export interface WatchServiceHostState {
  disposed: () => boolean;
  getCollections: () => Collection[];
  setCollections: (collections: Collection[]) => void;
  getSyncOptions: () => SyncOptions;
  setSyncOptions: (syncOptions: SyncOptions) => void;
  watchers: Map<string, FSWatcher>;
  watchRoots: Map<string, string>;
  collectionFingerprints: Map<string, string>;
  collectionGenerations: Map<string, number>;
  nextGeneration: () => number;
  failedCollections: Map<string, string>;
  snapshots: Map<string, WatcherSnapshot>;
  snapshotReady: Map<string, boolean>;
  snapshotInit: Map<string, Promise<void>>;
  syncing: Set<string>;
  pendingByCollection: Map<string, CollectionPending>;
  clearCollectionRuntimeState: (collectionName: string) => void;
  beginSnapshotInit: (collection: Collection) => void;
  watchFactory: WatchLifecycleHost["watchFactory"];
  onWatchEvent: WatchLifecycleHost["onWatchEvent"];
  findCollection: (collectionName: string) => Collection | undefined;
  clock: () => number;
  suppressedPaths: Map<string, number>;
  setLastEventAt: (iso: string) => void;
  enqueueExact: (collectionName: string, relPath: string) => void;
  enqueueDirty: (collectionName: string, hint: string) => void;
  flushDebounceMs: number;
  maxFlushDelayMs: number;
  maxExactPaths: number;
  maxDirtyHints: number;
  flushDeadlineAt: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  retryScheduled: Set<string>;
  inFlightSyncs: Set<Promise<void>>;
  runFlush: (collectionName: string) => Promise<void>;
}

export function buildLifecycleHost(
  state: WatchServiceHostState
): WatchLifecycleHost {
  return {
    disposed: state.disposed,
    getCollections: state.getCollections,
    setCollections: state.setCollections,
    getSyncOptions: state.getSyncOptions,
    setSyncOptions: state.setSyncOptions,
    watchers: state.watchers,
    watchRoots: state.watchRoots,
    collectionFingerprints: state.collectionFingerprints,
    collectionGenerations: state.collectionGenerations,
    nextGeneration: state.nextGeneration,
    failedCollections: state.failedCollections,
    snapshots: state.snapshots,
    snapshotReady: state.snapshotReady,
    snapshotInit: state.snapshotInit,
    syncing: state.syncing,
    pendingByCollection: state.pendingByCollection,
    clearCollectionRuntimeState: state.clearCollectionRuntimeState,
    beginSnapshotInit: state.beginSnapshotInit,
    watchFactory: state.watchFactory,
    onWatchEvent: state.onWatchEvent,
  };
}

export function buildEventHost(state: WatchServiceHostState): WatchEventHost {
  return {
    disposed: state.disposed,
    findCollection: state.findCollection,
    clock: state.clock,
    suppressedPaths: state.suppressedPaths,
    setLastEventAt: state.setLastEventAt,
    enqueueExact: state.enqueueExact,
    enqueueDirty: state.enqueueDirty,
  };
}

export function buildQueueHost(state: WatchServiceHostState): WatchQueueHost {
  return {
    disposed: state.disposed,
    clock: state.clock,
    flushDebounceMs: state.flushDebounceMs,
    maxFlushDelayMs: state.maxFlushDelayMs,
    maxExactPaths: state.maxExactPaths,
    maxDirtyHints: state.maxDirtyHints,
    pendingByCollection: state.pendingByCollection,
    flushDeadlineAt: state.flushDeadlineAt,
    timers: state.timers,
    retryScheduled: state.retryScheduled,
    snapshotReady: state.snapshotReady,
    inFlightSyncs: state.inFlightSyncs,
    runFlush: state.runFlush,
  };
}
