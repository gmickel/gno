/**
 * Shared resident collection filesystem watcher for serve and daemon.
 * Exact eligible paths content-hash via syncPaths; ambiguous events use
 * snapshot/fallback reconciliation before a targeted batch.
 *
 * @module src/serve/watch-service
 */

import { watch, type FSWatcher } from "node:fs";
// node:path — Bun has no path utilities
import { normalize, sep } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult, SyncOptions } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentEvent, DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";
import type { WatcherSnapshot } from "./watch-snapshot";

import {
  WATCHER_MAX_DIRTY_HINTS,
  WATCHER_MAX_EXACT_PATHS,
  WATCHER_MAX_SUPPRESSION_ENTRIES,
  pruneSuppressionMap,
} from "./watch-reconciliation";
import {
  enqueueDirtyHint,
  enqueueExactPath,
  handleWatchEvent,
  requeueAfterFailure,
  scheduleFlush,
  startFlush,
  type WatchEventHost,
  type WatchQueueHost,
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_MAX_FLUSH_DELAY_MS,
} from "./watch-service-events";
import { flushCollectionOnce } from "./watch-service-flush";
import {
  applyCollectionUpdate,
  type WatchLifecycleHost,
} from "./watch-service-lifecycle";
import { beginSnapshotInit } from "./watch-service-snapshot";
import {
  emptyPending,
  pendingHasWork,
  takePending,
  type CollectionPending,
} from "./watch-service-state";

export interface CollectionWatchState {
  expectedCollections: string[];
  activeCollections: string[];
  failedCollections: Array<{ collection: string; reason: string }>;
  queuedCollections: string[];
  syncingCollections: string[];
  lastEventAt: string | null;
  lastSyncAt: string | null;
}

export interface CollectionWatchCallbacks {
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
  /** Fires after all watcher syncs and queued paths have settled. */
  onSettled?: () => void;
}

interface CollectionWatchServiceOptions {
  collections: Collection[];
  store: SqliteAdapter;
  scheduler: EmbedScheduler | null;
  eventBus?: DocumentEventBus | null;
  callbacks?: CollectionWatchCallbacks;
  syncOptions?: SyncOptions;
  watchFactory?: typeof watch;
  /** Test overrides for debounce / hard deadline (milliseconds). */
  flushDebounceMs?: number;
  maxFlushDelayMs?: number;
  maxExactPaths?: number;
  maxDirtyHints?: number;
  clock?: () => number;
}

export class CollectionWatchService {
  #collections: Collection[];
  readonly #store: SqliteAdapter;
  readonly #scheduler: EmbedScheduler | null;
  readonly #eventBus: DocumentEventBus | null;
  readonly #callbacks: CollectionWatchCallbacks | null;
  #syncOptions: SyncOptions;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #watchRoots = new Map<string, string>();
  readonly #collectionGenerations = new Map<string, number>();
  readonly #collectionFingerprints = new Map<string, string>();
  readonly #pendingByCollection = new Map<string, CollectionPending>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #flushDeadlineAt = new Map<string, number>();
  readonly #syncing = new Set<string>();
  readonly #inFlightSyncs = new Set<Promise<void>>();
  readonly #suppressedPaths = new Map<string, number>();
  readonly #snapshots = new Map<string, WatcherSnapshot>();
  readonly #snapshotReady = new Map<string, boolean>();
  readonly #snapshotInit = new Map<string, Promise<void>>();
  readonly #watchFactory: typeof watch;
  readonly #failedCollections = new Map<string, string>();
  readonly #flushDebounceMs: number;
  readonly #maxFlushDelayMs: number;
  readonly #maxExactPaths: number;
  readonly #maxDirtyHints: number;
  readonly #clock: () => number;
  #nextCollectionGeneration = 0;
  #disposed = false;
  #lastEventAt: string | null = null;
  #lastSyncAt: string | null = null;

  constructor(options: CollectionWatchServiceOptions) {
    this.#collections = options.collections;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#eventBus = options.eventBus ?? null;
    this.#callbacks = options.callbacks ?? null;
    this.#syncOptions = options.syncOptions ?? {};
    this.#watchFactory = options.watchFactory ?? watch;
    this.#flushDebounceMs =
      options.flushDebounceMs ?? WATCHER_FLUSH_DEBOUNCE_MS;
    this.#maxFlushDelayMs =
      options.maxFlushDelayMs ?? WATCHER_MAX_FLUSH_DELAY_MS;
    this.#maxExactPaths = options.maxExactPaths ?? WATCHER_MAX_EXACT_PATHS;
    this.#maxDirtyHints = options.maxDirtyHints ?? WATCHER_MAX_DIRTY_HINTS;
    this.#clock = options.clock ?? Date.now;
  }

  start(): void {
    if (this.#disposed) {
      return;
    }
    this.updateCollections(this.#collections);
  }

  updateCollections(
    collections: Collection[],
    syncOptions?: SyncOptions
  ): void {
    applyCollectionUpdate(this.#lifecycleHost(), collections, syncOptions);
  }

  suppress(absPath: string, ms = 5_000): void {
    const now = this.#clock();
    this.#suppressedPaths.set(normalize(absPath), now + ms);
    pruneSuppressionMap(
      this.#suppressedPaths,
      now,
      WATCHER_MAX_SUPPRESSION_ENTRIES
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#timers.clear();
    this.#flushDeadlineAt.clear();
    this.#watchers.clear();
    this.#watchRoots.clear();
    this.#collectionGenerations.clear();
    this.#collectionFingerprints.clear();
    this.#collections = [];
    this.#pendingByCollection.clear();
    this.#snapshots.clear();
    this.#snapshotReady.clear();
    this.#snapshotInit.clear();
    this.#suppressedPaths.clear();
    await Promise.allSettled(this.#inFlightSyncs);
    this.#syncing.clear();
  }

  getState(): CollectionWatchState {
    return {
      expectedCollections: this.#collections.map(
        (collection) => collection.name
      ),
      activeCollections: [...this.#watchers.keys()],
      failedCollections: [...this.#failedCollections.entries()].map(
        ([collection, reason]) => ({ collection, reason })
      ),
      queuedCollections: [...this.#pendingByCollection.entries()]
        .filter(([, pending]) => pendingHasWork(pending))
        .map(([collectionName]) => collectionName),
      syncingCollections: [...this.#syncing],
      lastEventAt: this.#lastEventAt,
      lastSyncAt: this.#lastSyncAt,
    };
  }

  #lifecycleHost(): WatchLifecycleHost {
    return {
      disposed: () => this.#disposed,
      getCollections: () => this.#collections,
      setCollections: (collections) => {
        this.#collections = collections;
      },
      getSyncOptions: () => this.#syncOptions,
      setSyncOptions: (syncOptions) => {
        this.#syncOptions = syncOptions;
      },
      watchers: this.#watchers,
      watchRoots: this.#watchRoots,
      collectionFingerprints: this.#collectionFingerprints,
      collectionGenerations: this.#collectionGenerations,
      nextGeneration: () => ++this.#nextCollectionGeneration,
      failedCollections: this.#failedCollections,
      snapshots: this.#snapshots,
      snapshotReady: this.#snapshotReady,
      snapshotInit: this.#snapshotInit,
      clearCollectionRuntimeState: (collectionName) => {
        this.#clearCollectionRuntimeState(collectionName);
      },
      beginSnapshotInit: (collection) => {
        this.#beginSnapshotInit(collection);
      },
      watchFactory: this.#watchFactory,
      onWatchEvent: (collectionName, watchedRoot, filename) => {
        this.#onWatchEvent(collectionName, watchedRoot, filename);
      },
    };
  }

  #eventHost(): WatchEventHost {
    return {
      disposed: () => this.#disposed,
      findCollection: (collectionName) =>
        this.#collections.find((entry) => entry.name === collectionName),
      clock: this.#clock,
      suppressedPaths: this.#suppressedPaths,
      setLastEventAt: (iso) => {
        this.#lastEventAt = iso;
      },
      enqueueExact: (collectionName, relPath) => {
        this.#enqueueExact(collectionName, relPath);
      },
      enqueueDirty: (collectionName, hint) => {
        this.#enqueueDirty(collectionName, hint);
      },
    };
  }

  #queueHost(): WatchQueueHost {
    return {
      disposed: () => this.#disposed,
      clock: this.#clock,
      flushDebounceMs: this.#flushDebounceMs,
      maxFlushDelayMs: this.#maxFlushDelayMs,
      maxExactPaths: this.#maxExactPaths,
      maxDirtyHints: this.#maxDirtyHints,
      pendingByCollection: this.#pendingByCollection,
      flushDeadlineAt: this.#flushDeadlineAt,
      timers: this.#timers,
      snapshotReady: this.#snapshotReady,
      inFlightSyncs: this.#inFlightSyncs,
      runFlush: (collectionName) => this.#flushCollection(collectionName),
    };
  }

  #clearCollectionRuntimeState(collectionName: string): void {
    this.#watchRoots.delete(collectionName);
    this.#pendingByCollection.delete(collectionName);
    this.#snapshots.delete(collectionName);
    this.#snapshotReady.delete(collectionName);
    this.#snapshotInit.delete(collectionName);
    this.#flushDeadlineAt.delete(collectionName);
    const timer = this.#timers.get(collectionName);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(collectionName);
    }
  }

  #beginSnapshotInit(collection: Collection): void {
    beginSnapshotInit(
      {
        disposed: () => this.#disposed,
        getGeneration: (name) => this.#collectionGenerations.get(name) ?? 0,
        getRoot: (name) => this.#watchRoots.get(name),
        setSnapshot: (name, snapshot) => {
          this.#snapshots.set(name, snapshot);
        },
        clearSnapshot: (name) => {
          this.#snapshots.delete(name);
        },
        setReady: (name, ready) => {
          this.#snapshotReady.set(name, ready);
        },
        getInit: (name) => this.#snapshotInit.get(name),
        setInit: (name, init) => {
          if (init) {
            this.#snapshotInit.set(name, init);
          } else {
            this.#snapshotInit.delete(name);
          }
        },
        onReadyWithPending: (name) => {
          if (pendingHasWork(this.#pendingByCollection.get(name))) {
            scheduleFlush(this.#queueHost(), name);
          }
        },
      },
      collection
    );
  }

  #onWatchEvent(
    collectionName: string,
    watchedRoot: string,
    filename: string | Buffer | null | undefined
  ): void {
    handleWatchEvent(this.#eventHost(), collectionName, watchedRoot, filename);
  }

  #enqueueExact(collectionName: string, relPath: string): void {
    enqueueExactPath(this.#queueHost(), collectionName, relPath);
  }

  #enqueueDirty(collectionName: string, hint: string): void {
    enqueueDirtyHint(this.#queueHost(), collectionName, hint);
  }

  #startFlush(collectionName: string): void {
    startFlush(this.#queueHost(), collectionName);
  }

  async #flushCollection(collectionName: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const pending = this.#pendingByCollection.get(collectionName);
    if (!pendingHasWork(pending)) {
      this.#flushDeadlineAt.delete(collectionName);
      return;
    }
    if (this.#syncing.has(collectionName) || !pending) {
      return;
    }

    const collection = this.#collections.find(
      (entry) => entry.name === collectionName
    );
    if (!collection) {
      this.#pendingByCollection.delete(collectionName);
      this.#flushDeadlineAt.delete(collectionName);
      return;
    }

    const taken = takePending(pending);
    this.#pendingByCollection.set(collectionName, emptyPending());
    this.#flushDeadlineAt.delete(collectionName);
    this.#syncing.add(collectionName);

    const queueHost = this.#queueHost();
    const requeue = (exact: string[], dirty: string[]): void => {
      requeueAfterFailure(queueHost, collectionName, exact, dirty);
    };

    try {
      const outcome = await flushCollectionOnce({
        collection,
        collectionName,
        store: this.#store,
        syncOptions: this.#syncOptions,
        exactTaken: taken.exact,
        dirtyTaken: taken.dirty,
        previousSnapshot: this.#snapshots.get(collectionName) ?? null,
        syncGeneration: this.#collectionGenerations.get(collectionName) ?? 0,
        disposed: () => this.#disposed,
        getCurrentCollection: () =>
          this.#collections.find((entry) => entry.name === collectionName),
        getCurrentGeneration: () =>
          this.#collectionGenerations.get(collectionName) ?? 0,
        onSyncStart: (relPaths) => {
          this.#callbacks?.onSyncStart?.({
            collection: collection.name,
            relPaths,
          });
        },
        onSyncComplete: (relPaths, result) => {
          this.#callbacks?.onSyncComplete?.({
            collection: collection.name,
            relPaths,
            result,
          });
        },
        onSyncError: (relPaths, error) => {
          this.#callbacks?.onSyncError?.({
            collection: collection.name,
            relPaths,
            error,
          });
        },
        onAfterSync: (current, relPaths) => {
          this.#afterSync(current, relPaths);
        },
        commitSnapshot: (snapshot) => {
          this.#snapshots.set(collectionName, snapshot);
        },
        invalidateSnapshot: (current) => {
          this.#snapshots.delete(collectionName);
          this.#snapshotReady.set(collectionName, false);
          this.#snapshotInit.delete(collectionName);
          this.#beginSnapshotInit(current);
        },
        requeue,
      });
      // Propagate unexpected throws only (file-level failures already requeued).
      if (
        outcome.status === "failed" &&
        outcome.error &&
        !(
          outcome.error instanceof Error &&
          outcome.error.message ===
            "One or more paths failed during watcher sync"
        )
      ) {
        throw outcome.error;
      }
    } finally {
      this.#syncing.delete(collectionName);
      pruneSuppressionMap(
        this.#suppressedPaths,
        this.#clock(),
        WATCHER_MAX_SUPPRESSION_ENTRIES
      );
      if (!this.#disposed) {
        if (pendingHasWork(this.#pendingByCollection.get(collectionName))) {
          this.#startFlush(collectionName);
        } else {
          this.#notifySettledIfIdle();
        }
      }
    }
  }

  #notifySettledIfIdle(): void {
    if (
      this.#syncing.size === 0 &&
      ![...this.#pendingByCollection.values()].some((pending) =>
        pendingHasWork(pending)
      )
    ) {
      this.#callbacks?.onSettled?.();
    }
  }

  #afterSync(collection: Collection, relPaths: string[]): void {
    if (this.#disposed || relPaths.length === 0) {
      return;
    }

    this.#lastSyncAt = new Date(this.#clock()).toISOString();
    this.#scheduler?.notifySyncComplete(relPaths);

    if (!this.#eventBus) {
      return;
    }

    for (const relPath of relPaths) {
      const event: DocumentEvent = {
        type: "document-changed",
        uri: `gno://${collection.name}/${relPath.split(sep).join("/")}`,
        collection: collection.name,
        relPath,
        origin: "watcher",
        changedAt: new Date(this.#clock()).toISOString(),
      };
      this.#eventBus.emit(event);
    }
  }
}
