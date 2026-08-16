/**
 * Per-collection snapshot baseline initialization for the resident watcher.
 *
 * @module src/serve/watch-service-snapshot
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { SyncOptions } from "../ingestion";
import type {
  WatcherSnapshot,
  WatcherSnapshotBuildResult,
  WatcherSnapshotOptions,
} from "./watch-snapshot";

import {
  createDirectoryAvailability,
  memoizeDirectoryAvailability,
  resolveSourceAvailability,
} from "../ingestion";
import { buildWatcherSnapshot } from "./watch-snapshot";

export interface SnapshotInitHost {
  disposed: () => boolean;
  getGeneration: (collectionName: string) => number;
  getRoot: (collectionName: string) => string | undefined;
  setSnapshot: (collectionName: string, snapshot: WatcherSnapshot) => void;
  clearSnapshot: (collectionName: string) => void;
  setReady: (collectionName: string, ready: boolean) => void;
  getInit: (collectionName: string) => Promise<void> | undefined;
  setInit: (collectionName: string, init: Promise<void> | undefined) => void;
  onReadyWithPending: (collectionName: string) => void;
  /** Current run-level overrides; omitted by narrow unit-test hosts. */
  getSyncOptions?: () => SyncOptions;
  /** Optional injectable builder for hung/slow-init tests. */
  buildSnapshot?: (
    rootAbs: string,
    options?: WatcherSnapshotOptions
  ) => Promise<WatcherSnapshotBuildResult>;
}

/** Start (or supersede) baseline construction; events may already be buffering. */
export function beginSnapshotInit(
  host: SnapshotInitHost,
  collection: Collection
): void {
  if (host.disposed()) {
    return;
  }
  const generation = host.getGeneration(collection.name);
  const root = normalize(collection.path);
  let init!: Promise<void>;
  init = runSnapshotInit(
    host,
    collection.name,
    root,
    generation,
    () => init,
    collection
  );
  host.setInit(collection.name, init);
  void init.catch(() => undefined);
}

async function runSnapshotInit(
  host: SnapshotInitHost,
  collectionName: string,
  root: string,
  generation: number,
  getInit: () => Promise<void>,
  collection: Collection
): Promise<void> {
  try {
    const builder = host.buildSnapshot ?? buildWatcherSnapshot;
    const availabilityMode = resolveSourceAvailability(
      collection,
      host.getSyncOptions?.()
    );
    const built = await builder(root, {
      directoryAvailability: memoizeDirectoryAvailability(
        createDirectoryAvailability(availabilityMode)
      ),
    });
    if (host.disposed()) {
      return;
    }
    if (
      host.getGeneration(collectionName) !== generation ||
      host.getRoot(collectionName) !== root
    ) {
      return;
    }
    if (built.status === "ok") {
      host.setSnapshot(collectionName, built.snapshot);
    } else {
      host.clearSnapshot(collectionName);
    }
  } catch {
    if (
      !host.disposed() &&
      host.getGeneration(collectionName) === generation &&
      host.getRoot(collectionName) === root
    ) {
      host.clearSnapshot(collectionName);
    }
  }

  if (host.getInit(collectionName) !== getInit()) {
    return;
  }
  host.setInit(collectionName, undefined);
  if (host.disposed()) {
    return;
  }
  // Readiness flips even on init failure so forceFallback classification can run.
  if (
    host.getGeneration(collectionName) === generation &&
    host.getRoot(collectionName) === root
  ) {
    host.setReady(collectionName, true);
    host.onReadyWithPending(collectionName);
  }
}
