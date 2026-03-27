import { watch, type FSWatcher } from "node:fs";
import { join, normalize, sep } from "node:path";

import type { Collection } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentEvent, DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";

import { defaultSyncService } from "../ingestion";

export interface CollectionWatchState {
  expectedCollections: string[];
  activeCollections: string[];
  failedCollections: Array<{ collection: string; reason: string }>;
  queuedCollections: string[];
  syncingCollections: string[];
  lastEventAt: string | null;
  lastSyncAt: string | null;
}

interface CollectionWatchServiceOptions {
  collections: Collection[];
  store: SqliteAdapter;
  scheduler: EmbedScheduler | null;
  eventBus: DocumentEventBus;
  watchFactory?: typeof watch;
}

export class CollectionWatchService {
  #collections: Collection[];
  readonly #store: SqliteAdapter;
  readonly #scheduler: EmbedScheduler | null;
  readonly #eventBus: DocumentEventBus;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #pendingByCollection = new Map<string, Set<string>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #syncing = new Set<string>();
  readonly #suppressedPaths = new Map<string, number>();
  readonly #watchFactory: typeof watch;
  readonly #failedCollections = new Map<string, string>();
  #lastEventAt: string | null = null;
  #lastSyncAt: string | null = null;

  constructor(options: CollectionWatchServiceOptions) {
    this.#collections = options.collections;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#eventBus = options.eventBus;
    this.#watchFactory = options.watchFactory ?? watch;
  }

  start(): void {
    this.updateCollections(this.#collections);
  }

  updateCollections(collections: Collection[]): void {
    this.#collections = collections;
    const nextNames = new Set(collections.map((collection) => collection.name));

    for (const [collectionName, watcher] of this.#watchers) {
      if (!nextNames.has(collectionName)) {
        watcher.close();
        this.#watchers.delete(collectionName);
        this.#failedCollections.delete(collectionName);
        this.#pendingByCollection.delete(collectionName);
        const timer = this.#timers.get(collectionName);
        if (timer) {
          clearTimeout(timer);
          this.#timers.delete(collectionName);
        }
        this.#syncing.delete(collectionName);
      }
    }

    for (const collection of this.#collections) {
      if (this.#watchers.has(collection.name)) {
        continue;
      }
      try {
        const watcher = this.#watchFactory(
          collection.path,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;
            const relPath = filename.toString().replaceAll("\\", "/");
            const fullPath = normalize(join(collection.path, relPath));
            const suppressedUntil = this.#suppressedPaths.get(fullPath);
            if (suppressedUntil && suppressedUntil > Date.now()) {
              return;
            }
            this.#lastEventAt = new Date().toISOString();
            this.#queueChange(collection.name, relPath);
          }
        );
        this.#watchers.set(collection.name, watcher);
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

  dispose(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#timers.clear();
    this.#watchers.clear();
    this.#pendingByCollection.clear();
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
        void this.#flushCollection(collectionName);
      }, 300)
    );
  }

  async #flushCollection(collectionName: string): Promise<void> {
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

    const relPaths = [...pending];
    this.#pendingByCollection.set(collectionName, new Set<string>());
    this.#syncing.add(collectionName);

    try {
      await defaultSyncService.syncCollection(collection, this.#store, {
        runUpdateCmd: false,
      });
      this.#afterSync(collection, relPaths);
    } finally {
      this.#syncing.delete(collectionName);
      const remaining = this.#pendingByCollection.get(collectionName);
      if (remaining && remaining.size > 0) {
        void this.#flushCollection(collectionName);
      }
    }
  }

  #afterSync(collection: Collection, relPaths: string[]): void {
    if (relPaths.length === 0) {
      return;
    }

    this.#lastSyncAt = new Date().toISOString();
    this.#scheduler?.notifySyncComplete(relPaths);

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
