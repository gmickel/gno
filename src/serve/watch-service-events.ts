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
  applyPendingForceFlags,
  computeFlushDelay,
  emptyPending,
  queueDirtyHint,
  queueExactPath,
  type CollectionPending,
  type PendingForceFlags,
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
  /** Collections with an explicit retry timer; finally must not bypass. */
  retryScheduled: Set<string>;
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
  // Ambiguous events before baseline readiness must force store/disk reconcile.
  if (!host.snapshotReady.get(collectionName)) {
    pending.forceFallback = true;
  }
  host.pendingByCollection.set(
    collectionName,
    queueDirtyHint(pending, hint, host.maxDirtyHints)
  );
  scheduleFlush(host, collectionName);
}

/** Queue work without arming timers (used by failure requeue). */
function queueWithoutSchedule(
  host: WatchQueueHost,
  collectionName: string,
  exact: string[],
  dirty: string[],
  forceFlags?: PendingForceFlags
): void {
  let pending = host.pendingByCollection.get(collectionName) ?? emptyPending();
  for (const path of exact) {
    pending = queueExactPath(pending, path, host.maxExactPaths);
  }
  for (const hint of dirty) {
    pending = queueDirtyHint(pending, hint, host.maxDirtyHints);
  }
  pending = applyPendingForceFlags(pending, forceFlags);
  host.pendingByCollection.set(collectionName, pending);
}

export function scheduleFlush(
  host: WatchQueueHost,
  collectionName: string
): void {
  if (host.disposed()) {
    return;
  }
  // Explicit retry owns the single timer; do not replace it with debounce.
  if (host.retryScheduled.has(collectionName)) {
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
    !pending.overflow &&
    !pending.forceFallback &&
    !pending.generationReconcile;
  // Exact eligible paths content-hash without a snapshot baseline. Dirty /
  // overflow / init-fallback / generation work waits so init-time ambiguous
  // events reconcile against a newer generation rather than empty unproven state.
  // Leave work queued with no timer; onReadyWithPending schedules exactly once.
  if (!host.snapshotReady.get(collectionName) && !exactOnly) {
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

/**
 * Re-arm pending work after a file-level failure with retry backoff.
 * At most one retry timer per collection; finally must not startFlush while set.
 * forceFallback/overflow survive until forced classification + sync succeed.
 */
export function requeueAfterFailure(
  host: WatchQueueHost,
  collectionName: string,
  exact: string[],
  dirty: string[],
  forceFlags?: PendingForceFlags
): void {
  queueWithoutSchedule(host, collectionName, exact, dirty, forceFlags);
  if (host.disposed()) {
    return;
  }
  if (host.retryScheduled.has(collectionName)) {
    // Pending already merged; existing retry timer remains the sole attempt.
    return;
  }
  host.retryScheduled.add(collectionName);
  const existingTimer = host.timers.get(collectionName);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  host.flushDeadlineAt.set(collectionName, host.clock() + host.maxFlushDelayMs);
  host.timers.set(
    collectionName,
    setTimeout(() => {
      host.timers.delete(collectionName);
      host.retryScheduled.delete(collectionName);
      startFlush(host, collectionName);
    }, WATCHER_RETRY_BACKOFF_MS)
  );
}

/** Mark durable generation-reconcile work and schedule a single retry. */
export function requeueGenerationReconcile(
  host: WatchQueueHost,
  collectionName: string
): void {
  const pending =
    host.pendingByCollection.get(collectionName) ?? emptyPending();
  pending.generationReconcile = true;
  host.pendingByCollection.set(collectionName, pending);
  requeueAfterFailure(host, collectionName, [], []);
}

// Re-export defaults used by the service constructor for a single import site.
export { WATCHER_FLUSH_DEBOUNCE_MS, WATCHER_MAX_FLUSH_DELAY_MS };
