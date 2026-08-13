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
    limits: syncOptions.limits ?? null,
    concurrency: syncOptions.concurrency ?? null,
    contentTypeRules: syncOptions.contentTypeRules ?? null,
    contentTypeRulesFingerprint:
      syncOptions.contentTypeRulesFingerprint ?? null,
    projectTypedEdges: syncOptions.projectTypedEdges ?? null,
  });
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
      host.failedCollections.delete(collectionName);
    }
  }

  for (const collectionName of host.collectionFingerprints.keys()) {
    if (!nextByName.has(collectionName)) {
      host.collectionFingerprints.delete(collectionName);
      host.collectionGenerations.set(collectionName, host.nextGeneration());
      host.clearCollectionRuntimeState(collectionName);
    }
  }

  host.setCollections(collections);
  for (const collection of collections) {
    const fingerprint = watcherCollectionFingerprint(
      collection,
      host.getSyncOptions()
    );
    if (host.collectionFingerprints.get(collection.name) !== fingerprint) {
      host.collectionFingerprints.set(collection.name, fingerprint);
      host.collectionGenerations.set(collection.name, host.nextGeneration());
      host.snapshots.delete(collection.name);
      host.snapshotReady.set(collection.name, false);
      host.snapshotInit.delete(collection.name);
      if (host.watchers.has(collection.name)) {
        host.beginSnapshotInit(collection);
      }
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
