/**
 * Settlement helpers for one collection watcher flush.
 *
 * @module src/serve/watch-service-flush-helpers
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult } from "../ingestion";

import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
import {
  failedSyncPaths,
  successfulChangedPaths,
} from "./watch-reconciliation";

export interface FlushNotifyInput {
  disposed: () => boolean;
  getCurrentCollection: () => Collection | undefined;
  getCurrentGeneration: () => number;
  ownerGeneration: number;
  ownerRoot: string;
  onSyncComplete: (relPaths: string[], result: CollectionSyncResult) => void;
  onAfterSync: (collection: Collection, relPaths: string[]) => void;
}

/**
 * Paths that content-changed (added/updated). Used for scheduler/events.
 * Does not include unchanged or pure inactive-only summary counts.
 */
export function contentChangedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  const fromFiles = successfulChangedPaths(result);
  if (result.files) {
    return fromFiles;
  }
  return result.filesAdded + result.filesUpdated > 0 ? fallbackPaths : [];
}

/**
 * onSyncComplete fires exactly once per completed sync result with the
 * operation path scope. onAfterSync/scheduler remain ownership-checked and
 * limited to successful added/updated paths.
 */
export function notifyCompletedSync(
  input: FlushNotifyInput,
  operationPaths: string[],
  result: CollectionSyncResult,
  ownership?: { generation: number; root: string }
): string[] {
  input.onSyncComplete(operationPaths, result);
  const changed = contentChangedPaths(result, operationPaths);
  if (changed.length === 0 || input.disposed()) {
    return changed;
  }
  const currentCollection = input.getCurrentCollection();
  if (!currentCollection) {
    return changed;
  }
  const expectedGen = ownership?.generation ?? input.ownerGeneration;
  const expectedRoot = ownership?.root ?? input.ownerRoot;
  if (
    input.getCurrentGeneration() !== expectedGen ||
    normalize(currentCollection.path) !== expectedRoot
  ) {
    return changed;
  }
  const filtered = changed.filter((relPath) =>
    matchesWalkPath(relPath, collectionToWalkConfig(currentCollection, 0))
  );
  if (filtered.length > 0) {
    input.onAfterSync(currentCollection, filtered);
  }
  return changed;
}

/**
 * Retry authority after a targeted sync. Top-level result.errors retain the
 * original exact operation even when every file receipt succeeded, unless
 * durable dirty or generation authority already covers the work.
 *
 * Dirty-derived candidate/removal failures retain the original dirty hints and
 * force flags until a full classified generation succeeds and nextSnapshot
 * commits — never replace dirty authority solely with the failed exact path.
 */
export function computeTargetedRetry(options: {
  result: CollectionSyncResult;
  submittedPaths: readonly string[];
  liveExact: readonly string[];
  settled: ReadonlySet<string>;
  dirtyHints: readonly string[];
  dirtyFailed: boolean;
  /**
   * True when this submission included dirty-classified candidates or
   * proven removals (not merely live exact paths).
   */
  dirtyDerivedSubmission: boolean;
  generationAuthority: boolean;
}): { retryExact: string[]; retainDirty: boolean } {
  const {
    result,
    submittedPaths,
    liveExact,
    settled,
    dirtyHints,
    dirtyFailed,
    dirtyDerivedSubmission,
    generationAuthority,
  } = options;
  const failed = failedSyncPaths(result, submittedPaths).filter(
    (path) => !settled.has(path)
  );
  const topLevelErrors = result.errors.length > 0;
  const dirtyDerivedFailure =
    dirtyDerivedSubmission &&
    (failed.length > 0 || topLevelErrors || result.filesErrored > 0);
  // Retain original dirty hints until classified work fully succeeds.
  const retainDirty =
    dirtyHints.length > 0 &&
    (dirtyFailed || dirtyDerivedFailure || topLevelErrors);

  if (generationAuthority) {
    // Full-collection reconcile covers exact + dirty authority.
    return { retryExact: failed, retainDirty: false };
  }

  if (topLevelErrors) {
    // Projection/top-level failure: requeue original exact paths unless
    // dirty-only operation (no exact) already retains authority via dirty.
    if (liveExact.length === 0) {
      return { retryExact: failed, retainDirty: true };
    }
    // Exact (and mixed exact+dirty): requeue all original exact for projection.
    // Successful content changes settle via afterSync only once; requeue still
    // re-runs authority so top-level errors can clear.
    return {
      retryExact: [...new Set([...failed, ...liveExact])],
      retainDirty,
    };
  }

  return { retryExact: failed, retainDirty };
}
