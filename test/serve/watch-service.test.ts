import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";

function createCollection(name: string, path: string): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
}

function createSyncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);
const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);

afterEach(() => {
  defaultSyncService.syncPaths = originalSyncPaths;
  defaultSyncService.syncCollection = originalSyncCollection;
});

describe("CollectionWatchService", () => {
  test("updateCollections adds new watchers and removes stale ones", () => {
    const closed: string[] = [];
    const watchCalls: string[] = [];

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit: () => undefined } as never,
      scheduler: null,
      store: {} as never,
      watchFactory: ((path: string) => {
        watchCalls.push(path);
        return {
          close: () => {
            closed.push(path);
          },
        };
      }) as never,
    });

    service.start();
    expect(service.getState().activeCollections).toEqual(["notes"]);

    service.updateCollections([
      createCollection("work", "/tmp/work"),
      createCollection("notes", "/tmp/notes"),
    ]);

    expect(service.getState().activeCollections.sort()).toEqual([
      "notes",
      "work",
    ]);
    expect(watchCalls).toEqual(["/tmp/notes", "/tmp/work"]);

    service.updateCollections([createCollection("work", "/tmp/work")]);
    expect(service.getState().activeCollections).toEqual(["work"]);
    expect(closed).toEqual(["/tmp/notes"]);
  });

  test("failed watcher starts are surfaced in state", () => {
    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit: () => undefined } as never,
      scheduler: null,
      store: {} as never,
      watchFactory: (() => {
        throw new Error("recursive watch unavailable");
      }) as never,
    });

    service.start();

    expect(service.getState().failedCollections).toEqual([
      { collection: "notes", reason: "recursive watch unavailable" },
    ]);
  });

  test("ignores paths excluded by collection rules before sync or broadcast", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const emit = mock((_event: unknown) => undefined);
    const notifySyncComplete = mock(() => undefined);
    const onSyncStart = mock(() => undefined);
    const syncPaths = mock(async () => createSyncResult());
    defaultSyncService.syncPaths =
      syncPaths as typeof defaultSyncService.syncPaths;

    const collection = createCollection("notes", "/tmp/notes");
    collection.exclude = [".obsidian"];
    const service = new CollectionWatchService({
      collections: [collection],
      eventBus: { emit } as never,
      scheduler: { notifySyncComplete } as never,
      store: {} as never,
      callbacks: { onSyncStart },
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", ".obsidian/.sync.lock");
    watcherCallback?.("change", "cover.png");
    await Bun.sleep(350);

    expect(syncPaths).not.toHaveBeenCalled();
    expect(onSyncStart).not.toHaveBeenCalled();
    expect(notifySyncComplete).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(service.getState().lastEventAt).toBeNull();
    expect(service.getState().lastSyncAt).toBeNull();
    await service.dispose();
  });

  test("rechecks live collection rules when queued paths flush", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seenPaths: string[][] = [];
    const onSettled = mock(() => undefined);

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      seenPaths.push(relPaths);
      return createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: relPaths.length,
      });
    }) as typeof defaultSyncService.syncPaths;
    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: null,
      scheduler: null,
      store: {} as never,
      callbacks: { onSettled },
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", "drafts/private.md");
    const updatedCollection = createCollection("notes", "/tmp/notes");
    updatedCollection.exclude = ["drafts"];
    service.updateCollections([updatedCollection]);
    await Bun.sleep(350);

    expect(seenPaths).toEqual([]);
    expect(onSettled).toHaveBeenCalledTimes(1);

    watcherCallback?.("change", "published.md");
    await Bun.sleep(350);
    expect(seenPaths).toEqual([["published.md"]]);
    await service.dispose();
  });

  test("suppresses completion side effects when live rules exclude an in-flight path", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const emit = mock((_event: unknown) => undefined);
    const notifySyncComplete = mock(() => undefined);
    const syncCollection = mock(async () =>
      createSyncResult({ filesMarkedInactive: 1 })
    );
    let finishSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      await syncGate;
      return createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: relPaths.length,
      });
    }) as typeof defaultSyncService.syncPaths;
    defaultSyncService.syncCollection =
      syncCollection as typeof defaultSyncService.syncCollection;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit } as never,
      scheduler: { notifySyncComplete } as never,
      store: {} as never,
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", "private/note.md");
    await Bun.sleep(350);

    const updatedCollection = createCollection("notes", "/tmp/notes");
    updatedCollection.exclude = ["private"];
    service.updateCollections([updatedCollection]);
    finishSync?.();
    await Bun.sleep(20);

    expect(syncCollection).toHaveBeenCalledTimes(1);
    expect(notifySyncComplete).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    await service.dispose();
  });

  test("does not reconcile an in-flight sync for an equivalent config refresh", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const emit = mock((_event: unknown) => undefined);
    const syncCollection = mock(async () => createSyncResult());
    let finishSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      await syncGate;
      return createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: relPaths.length,
      });
    }) as typeof defaultSyncService.syncPaths;
    defaultSyncService.syncCollection =
      syncCollection as typeof defaultSyncService.syncCollection;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit } as never,
      scheduler: null,
      store: {} as never,
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", "note.md");
    await Bun.sleep(350);

    service.updateCollections([createCollection("notes", "/tmp/notes")]);
    finishSync?.();
    await Bun.sleep(20);

    expect(syncCollection).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  test("does not reconcile or emit after disposal during an in-flight sync", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const emit = mock((_event: unknown) => undefined);
    const notifySyncComplete = mock(() => undefined);
    const onSyncComplete = mock(() => undefined);
    const syncCollection = mock(async () => createSyncResult());
    let finishSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    defaultSyncService.syncPaths = (async () => {
      await syncGate;
      return createSyncResult({ filesUpdated: 1 });
    }) as typeof defaultSyncService.syncPaths;
    defaultSyncService.syncCollection =
      syncCollection as typeof defaultSyncService.syncCollection;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit } as never,
      scheduler: { notifySyncComplete } as never,
      store: {} as never,
      callbacks: { onSyncComplete },
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", "note.md");
    await Bun.sleep(350);

    const disposal = service.dispose();
    finishSync?.();
    await disposal;

    expect(syncCollection).not.toHaveBeenCalled();
    expect(onSyncComplete).not.toHaveBeenCalled();
    expect(notifySyncComplete).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test("restarts a watcher when a collection root changes", async () => {
    const watchedPaths: string[] = [];
    const closedPaths: string[] = [];
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/old-notes")],
      eventBus: null,
      scheduler: null,
      store: {} as never,
      watchFactory: ((
        path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watchedPaths.push(path);
        callbacks.set(
          path,
          callback as (eventType: string, filename: string) => void
        );
        return {
          close: () => {
            closedPaths.push(path);
          },
        };
      }) as never,
    });

    service.start();
    service.updateCollections([
      createCollection("notes", "/tmp/replacement-notes"),
    ]);

    expect(watchedPaths).toEqual(["/tmp/old-notes", "/tmp/replacement-notes"]);
    expect(closedPaths).toEqual(["/tmp/old-notes"]);
    expect(service.getState().activeCollections).toEqual(["notes"]);
    expect(callbacks.size).toBe(2);
    await service.dispose();
  });

  test("serializes remove and re-add behind an in-flight sync without an ABA collision", async () => {
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    const seenPaths: string[][] = [];
    const emit = mock((_event: unknown) => undefined);
    const notifySyncComplete = mock(() => undefined);
    const syncCollection = mock(async () =>
      createSyncResult({
        filesProcessed: 1,
        filesAdded: 1,
        files: [{ relPath: "new.md", status: "added" }],
      })
    );
    let finishFirstSync: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve;
    });

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      seenPaths.push(relPaths);
      if (seenPaths.length === 1) {
        await firstSync;
      }
      const status = seenPaths.length === 1 ? "updated" : "unchanged";
      return createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: status === "updated" ? relPaths.length : 0,
        filesUnchanged: status === "unchanged" ? relPaths.length : 0,
        files: relPaths.map((relPath) => ({ relPath, status })),
      });
    }) as typeof defaultSyncService.syncPaths;
    defaultSyncService.syncCollection =
      syncCollection as typeof defaultSyncService.syncCollection;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/old-notes")],
      eventBus: { emit } as never,
      scheduler: { notifySyncComplete } as never,
      store: {} as never,
      watchFactory: ((
        path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        callbacks.set(
          path,
          callback as (eventType: string, filename: string) => void
        );
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    callbacks.get("/tmp/old-notes")?.("change", "old.md");
    await Bun.sleep(350);
    expect(seenPaths).toEqual([["old.md"]]);

    service.updateCollections([]);
    service.updateCollections([
      createCollection("notes", "/tmp/replacement-notes"),
    ]);
    callbacks.get("/tmp/replacement-notes")?.("change", "new.md");
    await Bun.sleep(350);
    expect(seenPaths).toEqual([["old.md"]]);

    finishFirstSync?.();
    await Bun.sleep(20);
    expect(syncCollection).toHaveBeenCalledTimes(1);
    expect(seenPaths).toEqual([["old.md"], ["new.md"]]);
    expect(notifySyncComplete).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      collection: "notes",
      relPath: "new.md",
      uri: "gno://notes/new.md",
    });
    await service.dispose();
  });

  test("reprocesses an edit queued after full reconciliation scanned its path", async () => {
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    const seenPaths: string[][] = [];
    let finishFirstSync: (() => void) | undefined;
    let finishFullSync: (() => void) | undefined;
    let markFullSyncStarted: (() => void) | undefined;
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve;
    });
    const fullSyncGate = new Promise<void>((resolve) => {
      finishFullSync = resolve;
    });
    const fullSyncStarted = new Promise<void>((resolve) => {
      markFullSyncStarted = resolve;
    });

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      seenPaths.push(relPaths);
      if (seenPaths.length === 1) {
        await firstSync;
      }
      return createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: relPaths.length,
        files: relPaths.map((relPath) => ({
          relPath,
          status: "updated",
        })),
      });
    }) as typeof defaultSyncService.syncPaths;
    defaultSyncService.syncCollection = (async () => {
      markFullSyncStarted?.();
      await fullSyncGate;
      return createSyncResult({
        filesProcessed: 1,
        filesAdded: 1,
        files: [{ relPath: "new.md", status: "added" }],
      });
    }) as typeof defaultSyncService.syncCollection;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/old-notes")],
      eventBus: null,
      scheduler: null,
      store: {} as never,
      watchFactory: ((
        path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        callbacks.set(
          path,
          callback as (eventType: string, filename: string) => void
        );
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    callbacks.get("/tmp/old-notes")?.("change", "old.md");
    await Bun.sleep(350);
    service.updateCollections([
      createCollection("notes", "/tmp/replacement-notes"),
    ]);

    finishFirstSync?.();
    await fullSyncStarted;
    callbacks.get("/tmp/replacement-notes")?.("change", "new.md");
    await Bun.sleep(350);
    finishFullSync?.();
    await Bun.sleep(20);

    expect(seenPaths).toEqual([["old.md"], ["new.md"]]);
    await service.dispose();
  });

  test("forwards eligible deletion paths for inactive sync and one notification", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seenPaths: string[][] = [];
    const emit = mock((_event: unknown) => undefined);
    const notifySyncComplete = mock(() => undefined);

    defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
      seenPaths.push(relPaths);
      return createSyncResult({
        filesProcessed: 1,
        filesUpdated: 1,
        filesMarkedInactive: 1,
      });
    }) as typeof defaultSyncService.syncPaths;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit } as never,
      scheduler: { notifySyncComplete } as never,
      store: {} as never,
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return { close: () => undefined };
      }) as never,
    });

    service.start();
    watcherCallback?.("rename", "deleted.md");
    await Bun.sleep(350);

    expect(seenPaths).toEqual([["deleted.md"]]);
    expect(notifySyncComplete).toHaveBeenCalledTimes(1);
    expect(notifySyncComplete).toHaveBeenCalledWith(["deleted.md"]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      relPath: "deleted.md",
      uri: "gno://notes/deleted.md",
    });
    await service.dispose();
  });

  test("supports headless mode without event bus and emits sync callbacks", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const onSyncStart = mock(() => undefined);
    const onSyncComplete = mock(() => undefined);

    defaultSyncService.syncPaths = (async () => ({
      collection: "notes",
      filesProcessed: 1,
      filesAdded: 1,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesErrored: 0,
      filesSkipped: 0,
      filesMarkedInactive: 0,
      durationMs: 3,
      errors: [],
    })) as typeof defaultSyncService.syncPaths;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: null,
      scheduler: null,
      store: {} as never,
      callbacks: {
        onSyncStart,
        onSyncComplete,
      },
      watchFactory: ((
        path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return {
          close: () => {
            void path;
          },
        };
      }) as never,
    });

    service.start();
    watcherCallback?.("change", "doc.md");
    await Bun.sleep(350);

    expect(onSyncStart).toHaveBeenCalledTimes(1);
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  test("updateCollections refreshes sync options for later watcher syncs", async () => {
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seenFingerprints: Array<string | undefined> = [];
    const seenPaths: string[][] = [];

    defaultSyncService.syncPaths = (async (
      _collection,
      _store,
      relPaths,
      options
    ) => {
      seenPaths.push(relPaths);
      seenFingerprints.push(options?.contentTypeRulesFingerprint);
      return {
        collection: "notes",
        filesProcessed: 1,
        filesAdded: 0,
        filesUpdated: 1,
        filesUnchanged: 0,
        filesErrored: 0,
        filesSkipped: 0,
        filesMarkedInactive: 0,
        durationMs: 3,
        errors: [],
      };
    }) as typeof defaultSyncService.syncPaths;

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: null,
      scheduler: null,
      store: {} as never,
      syncOptions: { contentTypeRulesFingerprint: "before" },
      watchFactory: ((
        _path: string,
        _options: { recursive: boolean },
        callback: WatchListener<string>
      ) => {
        watcherCallback = callback as typeof watcherCallback;
        return {
          close: () => undefined,
        };
      }) as never,
    });

    service.start();
    service.updateCollections([createCollection("notes", "/tmp/notes")], {
      contentTypeRulesFingerprint: "after",
    });
    watcherCallback?.("change", "doc.md");
    await Bun.sleep(350);

    expect(seenFingerprints).toEqual(["after"]);
    expect(seenPaths).toEqual([["doc.md"]]);
    await service.dispose();
  });
});
