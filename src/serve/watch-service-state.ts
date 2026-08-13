/**
 * Per-collection pending queues, caps, and flush scheduling helpers.
 *
 * @module src/serve/watch-service-state
 */

import {
  WATCHER_MAX_DIRTY_HINTS,
  WATCHER_MAX_EXACT_PATHS,
  WATCHER_MAX_FLUSH_DELAY_MS,
  WATCHER_FLUSH_DEBOUNCE_MS,
  addToCappedSet,
} from "./watch-reconciliation";

export interface CollectionPending {
  exact: Set<string>;
  dirty: Set<string>;
  /** When true, dirty overflow forced a root-wide fallback hint. */
  overflow: boolean;
}

export function emptyPending(): CollectionPending {
  return { exact: new Set(), dirty: new Set(), overflow: false };
}

export function pendingHasWork(
  pending: CollectionPending | undefined
): boolean {
  return Boolean(pending && (pending.exact.size > 0 || pending.dirty.size > 0));
}

export function queueExactPath(
  pending: CollectionPending,
  relPath: string,
  maxExact: number = WATCHER_MAX_EXACT_PATHS
): CollectionPending {
  const result = addToCappedSet(pending.exact, relPath, maxExact);
  if (result === "overflow") {
    pending.overflow = true;
    pending.dirty.add("");
  }
  return pending;
}

export function queueDirtyHint(
  pending: CollectionPending,
  hint: string,
  maxDirty: number = WATCHER_MAX_DIRTY_HINTS
): CollectionPending {
  const result = addToCappedSet(pending.dirty, hint, maxDirty);
  if (result === "overflow") {
    pending.overflow = true;
    pending.dirty.clear();
    pending.dirty.add("");
  }
  return pending;
}

/** Drain pending work for one flush attempt. */
export function takePending(pending: CollectionPending): {
  exact: string[];
  dirty: string[];
} {
  return {
    exact: [...pending.exact],
    dirty: pending.overflow ? ["", ...pending.dirty] : [...pending.dirty],
  };
}

export interface FlushSchedule {
  delayMs: number;
  deadlineAt: number;
}

/**
 * Compute debounce delay respecting the hard maximum flush deadline.
 * `deadlineAt` is created on the first event of a window and retained until drain.
 */
export function computeFlushDelay(options: {
  nowMs: number;
  existingDeadlineAt: number | undefined;
  debounceMs?: number;
  maxFlushDelayMs?: number;
}): FlushSchedule {
  const debounceMs = options.debounceMs ?? WATCHER_FLUSH_DEBOUNCE_MS;
  const maxFlushDelayMs = options.maxFlushDelayMs ?? WATCHER_MAX_FLUSH_DELAY_MS;
  const deadlineAt =
    options.existingDeadlineAt ?? options.nowMs + maxFlushDelayMs;
  const untilDeadline = Math.max(0, deadlineAt - options.nowMs);
  return {
    delayMs: Math.min(debounceMs, untilDeadline),
    deadlineAt,
  };
}
