/**
 * Collection watcher lifecycle: fingerprinting and updateCollections.
 *
 * @module src/serve/watch-service-lifecycle
 */

import type { FSWatcher } from "node:fs";

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { SyncOptions } from "../ingestion";
import type { WatcherSnapshot } from "./watch-snapshot";

import { resolveSourceAvailability } from "../ingestion/source-availability";
import { emptyPending, type CollectionPending } from "./watch-service-state";

export interface WatchLifecycleHost {
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
  /** Collections currently mid-flush (ABA ownership). */
  syncing: Set<string>;
  /**
   * Pending work by collection. Config/generation invalidation marks dirty work
   * forceFallback + durable generation reconcile so a new baseline cannot absorb it.
   */
  pendingByCollection: Map<string, CollectionPending>;
  clearCollectionRuntimeState: (collectionName: string) => void;
  beginSnapshotInit: (collection: Collection) => void;
  watchFactory: (
    path: string,
    options: { recursive: boolean },
    listener: (
      eventType: string,
      filename: string | Buffer | null | undefined
    ) => void
  ) => FSWatcher;
  onWatchEvent: (
    collectionName: string,
    watchedRoot: string,
    filename: string | Buffer | null | undefined
  ) => void;
}

export function watcherCollectionFingerprint(
  collection: Collection,
  syncOptions: SyncOptions
): string {
  return JSON.stringify({
    path: normalize(collection.path),
    pattern: collection.pattern,
    include: collection.include,
    exclude: collection.exclude,
    languageHint: collection.languageHint ?? null,
    recordAdapters: collection.recordAdapters ?? null,
    sourceAvailability: resolveSourceAvailability(collection, syncOptions),
    limits: syncOptions.limits ?? null,
    concurrency: syncOptions.concurrency ?? null,
    contentTypeRules: syncOptions.contentTypeRules ?? null,
    contentTypeRulesFingerprint:
      syncOptions.contentTypeRulesFingerprint ?? null,
    projectTypedEdges: syncOptions.projectTypedEdges ?? null,
  });
}

/**
 * Drop generation/failed tombstones when the name is no longer configured and
 * no in-flight flush still needs the ownership token.
 */
export function clearLifecycleTombstones(
  host: WatchLifecycleHost,
  collectionName: string
): void {
  if (host.syncing.has(collectionName)) {
    return;
  }
  if (host.getCollections().some((entry) => entry.name === collectionName)) {
    return;
  }
  host.collectionGenerations.delete(collectionName);
  host.failedCollections.delete(collectionName);
  host.collectionFingerprints.delete(collectionName);
}

/**
 * Reconcile active watchers with the desired collection set.
 * Closes removed/moved roots, bumps generations on config change, and starts
 * new recursive watchers (capturing events before snapshot baseline init).
 */
export function applyCollectionUpdate(
  host: WatchLifecycleHost,
  collections: Collection[],
  syncOptions?: SyncOptions
): void {
  if (host.disposed()) {
    return;
  }
  if (syncOptions) {
    host.setSyncOptions(syncOptions);
  }
  const nextByName = new Map(
    collections.map((collection) => [collection.name, collection])
  );

  for (const [collectionName, watcher] of host.watchers) {
    const nextCollection = nextByName.get(collectionName);
    const nextRoot = nextCollection
      ? normalize(nextCollection.path)
      : undefined;
    if (
      nextRoot === undefined ||
      nextRoot !== host.watchRoots.get(collectionName)
    ) {
      watcher.close();
      host.watchers.delete(collectionName);
      host.clearCollectionRuntimeState(collectionName);
      if (nextRoot === undefined) {
        // Removed: bump generation for in-flight ABA, then clear if idle.
        host.collectionGenerations.set(collectionName, host.nextGeneration());
        host.failedCollections.delete(collectionName);
        clearLifecycleTombstones(host, collectionName);
      } else {
        host.failedCollections.delete(collectionName);
      }
    }
  }

  // Fingerprints / generations / failed for names no longer configured.
  for (const collectionName of [
    ...host.collectionFingerprints.keys(),
    ...host.collectionGenerations.keys(),
    ...host.failedCollections.keys(),
  ]) {
    if (nextByName.has(collectionName)) {
      continue;
    }
    host.collectionFingerprints.delete(collectionName);
    if (!host.collectionGenerations.has(collectionName)) {
      host.collectionGenerations.set(collectionName, host.nextGeneration());
    } else if (!host.syncing.has(collectionName)) {
      host.collectionGenerations.set(collectionName, host.nextGeneration());
    }
    host.clearCollectionRuntimeState(collectionName);
    clearLifecycleTombstones(host, collectionName);
  }

  host.setCollections(collections);
  for (const collection of collections) {
    const fingerprint = watcherCollectionFingerprint(
      collection,
      host.getSyncOptions()
    );
    const previousFingerprint = host.collectionFingerprints.get(
      collection.name
    );
    if (previousFingerprint === fingerprint) {
      continue;
    }
    host.collectionFingerprints.set(collection.name, fingerprint);
    host.collectionGenerations.set(collection.name, host.nextGeneration());
    host.snapshots.delete(collection.name);
    host.snapshotReady.set(collection.name, false);
    host.snapshotInit.delete(collection.name);
    // Initial start (no prior fingerprint): snapshot only — no full sync.
    // Every later material change (idle same-root, root replacement, exact-only
    // pending, dirty work) durably enqueues generation reconciliation.
    if (previousFingerprint !== undefined) {
      const pending =
        host.pendingByCollection.get(collection.name) ?? emptyPending();
      pending.generationReconcile = true;
      // Queued ambiguous work must not be absorbed by the new baseline.
      if (pending.dirty.size > 0 || pending.overflow || pending.forceFallback) {
        pending.forceFallback = true;
      }
      host.pendingByCollection.set(collection.name, pending);
    }
    if (host.watchers.has(collection.name)) {
      host.beginSnapshotInit(collection);
    }
  }

  for (const collection of host.getCollections()) {
    if (host.watchers.has(collection.name)) {
      continue;
    }
    try {
      const watchedRoot = normalize(collection.path);
      // Capture events BEFORE async snapshot baseline construction.
      const watcher = host.watchFactory(
        collection.path,
        { recursive: true },
        (_eventType, filename) => {
          host.onWatchEvent(collection.name, watchedRoot, filename);
        }
      );
      host.watchers.set(collection.name, watcher);
      host.watchRoots.set(collection.name, watchedRoot);
      host.failedCollections.delete(collection.name);
      host.snapshotReady.set(collection.name, false);
      host.beginSnapshotInit(collection);
    } catch (error) {
      host.failedCollections.set(
        collection.name,
        error instanceof Error ? error.message : "watch unavailable"
      );
    }
  }
}
