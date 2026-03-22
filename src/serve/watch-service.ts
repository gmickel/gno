import { watch, type FSWatcher } from "node:fs";
import { join, normalize, sep } from "node:path";

import type { Collection } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentEvent, DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";

import { defaultSyncService } from "../ingestion";

interface CollectionWatchServiceOptions {
  collections: Collection[];
  store: SqliteAdapter;
  scheduler: EmbedScheduler | null;
  eventBus: DocumentEventBus;
}

export class CollectionWatchService {
  readonly #collections: Collection[];
  readonly #store: SqliteAdapter;
  readonly #scheduler: EmbedScheduler | null;
  readonly #eventBus: DocumentEventBus;
  readonly #watchers: FSWatcher[] = [];
  readonly #pendingByCollection = new Map<string, Set<string>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #syncing = new Set<string>();
  readonly #suppressedPaths = new Map<string, number>();

  constructor(options: CollectionWatchServiceOptions) {
    this.#collections = options.collections;
    this.#store = options.store;
    this.#scheduler = options.scheduler;
    this.#eventBus = options.eventBus;
  }

  start(): void {
    for (const collection of this.#collections) {
      try {
        const watcher = watch(
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
            this.#queueChange(collection.name, relPath);
          }
        );
        this.#watchers.push(watcher);
      } catch {
        // Best-effort watch support; unsupported platforms can still rely on manual sync.
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
    for (const watcher of this.#watchers) {
      watcher.close();
    }
    this.#timers.clear();
    this.#watchers.length = 0;
    this.#pendingByCollection.clear();
    this.#syncing.clear();
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
