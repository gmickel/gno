/**
 * Watcher event intake, pending queues, and flush timer scheduling.
 *
 * @module src/serve/watch-service-events
 */

// node:path — Bun has no path utilities
import { join, normalize } from "node:path";

import type { Collection } from "../config/types";

import {
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_MAX_FLUSH_DELAY_MS,
  WATCHER_RETRY_BACKOFF_MS,
  classifyWatcherFilename,
} from "./watch-reconciliation";
import {
  computeFlushDelay,
  emptyPending,
  queueDirtyHint,
  queueExactPath,
  type CollectionPending,
} from "./watch-service-state";

export interface WatchEventHost {
  disposed: () => boolean;
  findCollection: (collectionName: string) => Collection | undefined;
  clock: () => number;
  suppressedPaths: Map<string, number>;
  setLastEventAt: (iso: string) => void;
  enqueueExact: (collectionName: string, relPath: string) => void;
  enqueueDirty: (collectionName: string, hint: string) => void;
}

export interface WatchQueueHost {
  disposed: () => boolean;
  clock: () => number;
  flushDebounceMs: number;
  maxFlushDelayMs: number;
  maxExactPaths: number;
  maxDirtyHints: number;
  pendingByCollection: Map<string, CollectionPending>;
  flushDeadlineAt: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  snapshotReady: Map<string, boolean>;
  inFlightSyncs: Set<Promise<void>>;
  runFlush: (collectionName: string) => Promise<void>;
}

/** Classify a filesystem watch callback and enqueue exact or dirty work. */
export function handleWatchEvent(
  host: WatchEventHost,
  collectionName: string,
  watchedRoot: string,
  filename: string | Buffer | null | undefined
): void {
  if (host.disposed()) {
    return;
  }
  const currentCollection = host.findCollection(collectionName);
  if (!currentCollection || normalize(currentCollection.path) !== watchedRoot) {
    return;
  }

  const classified = classifyWatcherFilename(filename, currentCollection);
  if (classified.kind === "reject" || classified.kind === "ignore") {
    return;
  }

  if (classified.kind === "exact") {
    const fullPath = normalize(join(watchedRoot, classified.relPath));
    const suppressedUntil = host.suppressedPaths.get(fullPath);
    if (suppressedUntil && suppressedUntil > host.clock()) {
      return;
    }
    host.setLastEventAt(new Date(host.clock()).toISOString());
    host.enqueueExact(collectionName, classified.relPath);
    return;
  }

  if (classified.hint !== "") {
    const fullPath = normalize(join(watchedRoot, classified.hint));
    const suppressedUntil = host.suppressedPaths.get(fullPath);
    if (suppressedUntil && suppressedUntil > host.clock()) {
      return;
    }
  }
  host.setLastEventAt(new Date(host.clock()).toISOString());
  host.enqueueDirty(collectionName, classified.hint);
}

export function enqueueExactPath(
  host: WatchQueueHost,
  collectionName: string,
  relPath: string
): void {
  const pending =
    host.pendingByCollection.get(collectionName) ?? emptyPending();
  host.pendingByCollection.set(
    collectionName,
    queueExactPath(pending, relPath, host.maxExactPaths)
  );
  scheduleFlush(host, collectionName);
}

export function enqueueDirtyHint(
  host: WatchQueueHost,
  collectionName: string,
  hint: string
): void {
  const pending =
    host.pendingByCollection.get(collectionName) ?? emptyPending();
  host.pendingByCollection.set(
    collectionName,
    queueDirtyHint(pending, hint, host.maxDirtyHints)
  );
  scheduleFlush(host, collectionName);
}

export function scheduleFlush(
  host: WatchQueueHost,
  collectionName: string
): void {
  if (host.disposed()) {
    return;
  }
  const schedule = computeFlushDelay({
    nowMs: host.clock(),
    existingDeadlineAt: host.flushDeadlineAt.get(collectionName),
    debounceMs: host.flushDebounceMs,
    maxFlushDelayMs: host.maxFlushDelayMs,
  });
  host.flushDeadlineAt.set(collectionName, schedule.deadlineAt);

  const existingTimer = host.timers.get(collectionName);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  host.timers.set(
    collectionName,
    setTimeout(() => {
      host.timers.delete(collectionName);
      startFlush(host, collectionName);
    }, schedule.delayMs)
  );
}

/**
 * Begin a flush when the debounce fires. Dirty/overflow work waits for snapshot
 * readiness; exact-only paths content-hash without a baseline.
 */
export function startFlush(host: WatchQueueHost, collectionName: string): void {
  if (host.disposed()) {
    return;
  }
  const pending = host.pendingByCollection.get(collectionName);
  const exactOnly =
    pending !== undefined &&
    pending.exact.size > 0 &&
    pending.dirty.size === 0 &&
    !pending.overflow;
  // Exact eligible paths content-hash without a snapshot baseline. Dirty /
  // overflow work waits so init-time ambiguous events reconcile against a
  // newer generation rather than an empty unproven snapshot.
  if (!host.snapshotReady.get(collectionName) && !exactOnly) {
    // Do not re-arm the full debounce while waiting for baseline; poll briefly.
    // Snapshot init also schedules a flush when readiness flips true.
    const existingTimer = host.timers.get(collectionName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    host.timers.set(
      collectionName,
      setTimeout(() => {
        host.timers.delete(collectionName);
        startFlush(host, collectionName);
      }, 10)
    );
    return;
  }
  const sync = host.runFlush(collectionName);
  host.inFlightSyncs.add(sync);
  void sync
    .finally(() => {
      host.inFlightSyncs.delete(sync);
    })
    .catch(() => undefined);
}

/** Re-arm pending work after a file-level failure with retry backoff. */
export function requeueAfterFailure(
  host: WatchQueueHost,
  collectionName: string,
  exact: string[],
  dirty: string[]
): void {
  for (const path of exact) {
    enqueueExactPath(host, collectionName, path);
  }
  for (const hint of dirty) {
    enqueueDirtyHint(host, collectionName, hint);
  }
  const timer = host.timers.get(collectionName);
  if (timer) {
    clearTimeout(timer);
  }
  host.flushDeadlineAt.set(collectionName, host.clock() + host.maxFlushDelayMs);
  host.timers.set(
    collectionName,
    setTimeout(() => {
      host.timers.delete(collectionName);
      startFlush(host, collectionName);
    }, WATCHER_RETRY_BACKOFF_MS)
  );
}

// Re-export defaults used by the service constructor for a single import site.
export { WATCHER_FLUSH_DEBOUNCE_MS, WATCHER_MAX_FLUSH_DELAY_MS };
