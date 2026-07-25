import { watch, type FSWatcher } from "node:fs";
import { join, normalize, sep } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult, SyncOptions } from "../ingestion";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentEvent, DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";

import {
  collectionToWalkConfig,
  defaultSyncService,
  matchesWalkPath,
} from "../ingestion";

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
}

function watcherCollectionFingerprint(
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

function changedPaths(
  result: CollectionSyncResult,
  fallbackPaths: string[] = []
): string[] {
  if (result.files) {
    return result.files
      .filter((file) => file.status === "added" || file.status === "updated")
      .map((file) => file.relPath);
  }
  return result.filesAdded + result.filesUpdated + result.filesMarkedInactive >
    0
    ? fallbackPaths
    : [];
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
  readonly #pendingByCollection = new Map<string, Set<string>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #syncing = new Set<string>();
  readonly #inFlightSyncs = new Set<Promise<void>>();
  readonly #suppressedPaths = new Map<string, number>();
  readonly #watchFactory: typeof watch;
  readonly #failedCollections = new Map<string, string>();
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
    if (this.#disposed) {
      return;
    }
    if (syncOptions) {
      this.#syncOptions = syncOptions;
    }
    const nextByName = new Map(
      collections.map((collection) => [collection.name, collection])
    );

    for (const [collectionName, watcher] of this.#watchers) {
      const nextCollection = nextByName.get(collectionName);
      const nextRoot = nextCollection
        ? normalize(nextCollection.path)
        : undefined;
      if (
        nextRoot === undefined ||
        nextRoot !== this.#watchRoots.get(collectionName)
      ) {
        watcher.close();
        this.#watchers.delete(collectionName);
        this.#watchRoots.delete(collectionName);
        this.#failedCollections.delete(collectionName);
        this.#pendingByCollection.delete(collectionName);
        const timer = this.#timers.get(collectionName);
        if (timer) {
          clearTimeout(timer);
          this.#timers.delete(collectionName);
        }
      }
    }

    for (const collectionName of this.#collectionFingerprints.keys()) {
      if (!nextByName.has(collectionName)) {
        this.#collectionFingerprints.delete(collectionName);
        this.#collectionGenerations.set(
          collectionName,
          ++this.#nextCollectionGeneration
        );
      }
    }

    this.#collections = collections;
    for (const collection of collections) {
      const fingerprint = watcherCollectionFingerprint(
        collection,
        this.#syncOptions
      );
      if (this.#collectionFingerprints.get(collection.name) !== fingerprint) {
        this.#collectionFingerprints.set(collection.name, fingerprint);
        this.#collectionGenerations.set(
          collection.name,
          ++this.#nextCollectionGeneration
        );
      }
    }

    for (const collection of this.#collections) {
      if (this.#watchers.has(collection.name)) {
        continue;
      }
      try {
        const watchedRoot = normalize(collection.path);
        const watcher = this.#watchFactory(
          collection.path,
          { recursive: true },
          (_eventType, filename) => {
            if (this.#disposed || !filename) return;
            const relPath = filename.toString().replaceAll("\\", "/");
            const currentCollection = this.#collections.find(
              (entry) => entry.name === collection.name
            );
            if (
              !currentCollection ||
              normalize(currentCollection.path) !== watchedRoot ||
              !matchesWalkPath(
                relPath,
                collectionToWalkConfig(currentCollection, 0)
              )
            ) {
              return;
            }
            const fullPath = normalize(join(watchedRoot, relPath));
            const suppressedUntil = this.#suppressedPaths.get(fullPath);
            if (suppressedUntil && suppressedUntil > Date.now()) {
              return;
            }
            this.#lastEventAt = new Date().toISOString();
            this.#queueChange(collection.name, relPath);
          }
        );
        this.#watchers.set(collection.name, watcher);
        this.#watchRoots.set(collection.name, watchedRoot);
        this.#failedCollections.delete(collection.name);
      } catch (error) {
        this.#failedCollections.set(
          collection.name,
          error instanceof Error ? error.message : "watch unavailable"
        );
      }
    }
  }

  suppress(absPath: string, ms = 5_000): void {
    this.#suppressedPaths.set(normalize(absPath), Date.now() + ms);
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
    this.#watchers.clear();
    this.#watchRoots.clear();
    this.#collectionGenerations.clear();
    this.#collectionFingerprints.clear();
    this.#collections = [];
    this.#pendingByCollection.clear();
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
        .filter(([, relPaths]) => relPaths.size > 0)
        .map(([collectionName]) => collectionName),
      syncingCollections: [...this.#syncing],
      lastEventAt: this.#lastEventAt,
      lastSyncAt: this.#lastSyncAt,
    };
  }

  #queueChange(collectionName: string, relPath: string): void {
    if (this.#disposed) {
      return;
    }
    const pending =
      this.#pendingByCollection.get(collectionName) ?? new Set<string>();
    pending.add(relPath);
    this.#pendingByCollection.set(collectionName, pending);

    const existingTimer = this.#timers.get(collectionName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    this.#timers.set(
      collectionName,
      setTimeout(() => {
        this.#startFlush(collectionName);
      }, 300)
    );
  }

  #startFlush(collectionName: string): void {
    if (this.#disposed) {
      return;
    }
    const sync = this.#flushCollection(collectionName);
    this.#inFlightSyncs.add(sync);
    void sync
      .finally(() => {
        this.#inFlightSyncs.delete(sync);
      })
      .catch(() => undefined);
  }

  async #flushCollection(collectionName: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const pending = this.#pendingByCollection.get(collectionName);
    if (!pending || pending.size === 0) {
      return;
    }
    if (this.#syncing.has(collectionName)) {
      return;
    }

    const collection = this.#collections.find(
      (entry) => entry.name === collectionName
    );
    if (!collection) {
      this.#pendingByCollection.delete(collectionName);
      return;
    }

    const relPaths = [...pending].filter((relPath) =>
      matchesWalkPath(relPath, collectionToWalkConfig(collection, 0))
    );
    let syncGeneration = this.#collectionGenerations.get(collectionName) ?? 0;
    this.#pendingByCollection.set(collectionName, new Set<string>());
    if (relPaths.length === 0) {
      this.#notifySettledIfIdle();
      return;
    }
    this.#syncing.add(collectionName);

    try {
      this.#callbacks?.onSyncStart?.({
        collection: collection.name,
        relPaths,
      });
      let result = await defaultSyncService.syncPaths(
        collection,
        this.#store,
        relPaths,
        {
          ...this.#syncOptions,
          runUpdateCmd: false,
        }
      );
      if (this.#disposed) {
        return;
      }
      this.#callbacks?.onSyncComplete?.({
        collection: collection.name,
        relPaths,
        result,
      });

      let completionCollection = collection;
      let completionPaths = changedPaths(result, relPaths);
      while (true) {
        const currentCollection = this.#collections.find(
          (entry) => entry.name === collectionName
        );
        if (!currentCollection) {
          break;
        }
        const currentGeneration =
          this.#collectionGenerations.get(collectionName) ?? 0;
        if (currentGeneration === syncGeneration) {
          const currentRelPaths =
            normalize(currentCollection.path) ===
            normalize(completionCollection.path)
              ? completionPaths.filter((relPath) =>
                  matchesWalkPath(
                    relPath,
                    collectionToWalkConfig(currentCollection, 0)
                  )
                )
              : [];
          if (currentRelPaths.length > 0) {
            this.#afterSync(currentCollection, currentRelPaths);
          }
          break;
        }

        result = await defaultSyncService.syncCollection(
          currentCollection,
          this.#store,
          {
            ...this.#syncOptions,
            runUpdateCmd: false,
          }
        );
        if (this.#disposed) {
          return;
        }
        completionCollection = currentCollection;
        completionPaths = changedPaths(result);
        syncGeneration = currentGeneration;
        this.#callbacks?.onSyncComplete?.({
          collection: currentCollection.name,
          relPaths: completionPaths,
          result,
        });
      }
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      this.#callbacks?.onSyncError?.({
        collection: collection.name,
        relPaths,
        error,
      });
      throw error;
    } finally {
      this.#syncing.delete(collectionName);
      if (!this.#disposed) {
        const remaining = this.#pendingByCollection.get(collectionName);
        if (remaining && remaining.size > 0) {
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
      ![...this.#pendingByCollection.values()].some(
        (relPaths) => relPaths.size > 0
      )
    ) {
      this.#callbacks?.onSettled?.();
    }
  }

  #afterSync(collection: Collection, relPaths: string[]): void {
    if (this.#disposed || relPaths.length === 0) {
      return;
    }

    this.#lastSyncAt = new Date().toISOString();
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
        changedAt: new Date().toISOString(),
      };
      this.#eventBus.emit(event);
    }
  }
}
