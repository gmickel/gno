import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, mock, test } from "bun:test";
// node:fs/promises is used for mkdtemp/mkdir/rm: Bun has no native equivalents
// for temp-directory creation or filesystem structure operations.
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type {
  CollectionSyncResult,
  VanishedPathOutcome,
} from "../../src/ingestion";

import {
  defaultSyncService,
  resolveVanishedPathDirectory,
} from "../../src/ingestion";
import {
  CollectionWatchService,
  MAX_DESCRIBED_VALUE_LENGTH,
} from "../../src/serve/watch-service";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

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

/**
 * fn-114 task .1 — RED regression coverage. These tests are EXPECTED TO FAIL
 * until the bounded directory-reconciliation path lands in fn-114 task .3.
 * They must not be weakened to go green.
 *
 * ## Provenance of the replayed sequences
 *
 * Every tuple below is a REAL capture, not an assumed shape. They were
 * recorded by `test/serve/watch-service.fs-smoke.test.ts` on Bun 1.3.11 under
 * linux 6.10.14 (Debian container, `tmpfs`-backed temp dir, so the events are
 * genuine inotify and not a degraded bind mount), cross-checked against the
 * same probe on darwin 25.5.0. Full capture:
 *
 * | scenario                   | linux 6.10.14 / Bun 1.3.11        | darwin 25.5.0 / Bun 1.3.11                                |
 * | -------------------------- | --------------------------------- | --------------------------------------------------------- |
 * | directCreate               | `direct.md`                       | `direct.md`                                                |
 * | atomicCreatePlainTemp      | `note.md.tmp`                     | `note.md.tmp`, `note.md`                                   |
 * | atomicCreateHiddenTemp     | `hidden-atomic.md`                | `.gno-tmp.abc123`, `hidden-atomic.md`                      |
 * | atomicReplaceNested        | `nested/note.md.tmp`              | `nested/note.md.tmp`, `nested/note.md`, `nested/note.md`   |
 * | fileDeletion               | `direct.md`                       | `direct.md`                                                |
 * | recursiveDirectoryDeletion | `dir1`                            | `dir1/b.md`, `dir1/a.md`, `dir1`                           |
 * | newSubdirectoryWrite       | (nothing)                         | `post/d.md`                                                |
 * | caseOnlyRename             | `foo.md`                          | `Foo.md`, `foo.md`                                         |
 *
 * What the capture actually establishes — some of it contradicts what the spec
 * assumed, and the tests follow the data:
 *
 * 1. oven-sh/bun#36328 is NOT fixed in Bun 1.3.11. For an atomic save through a
 *    PLAIN temp name, Linux reports only the SOURCE (`note.md.tmp`) and never
 *    the destination `note.md`. That is the ambiguous event this suite replays.
 * 2. A DOT-PREFIXED temp name behaves the opposite way, and not because the bug
 *    is fixed: Bun's Linux watcher never reports dot-prefixed names at all, so
 *    the source is filtered out and only the destination survives. A fixture
 *    built on `.gno-tmp.<id>` would therefore replay a sequence Linux never
 *    produces, and the current code already handles the one it does produce.
 * 3. A single-file delete DOES name the deleted file on both platforms — which
 *    is exactly why the existing green deletion test passes. The captured
 *    stale-active condition is a RECURSIVE DIRECTORY DELETE: Linux reports only
 *    `dir1`, never `dir1/a.md` or `dir1/b.md`, so both indexed documents stay
 *    active forever.
 * 4. Two further defects were captured and are recorded here for task .3 rather
 *    than asserted by this task: Linux does not extend recursion to
 *    subdirectories created after the watch began (`newSubdirectoryWrite`
 *    reported nothing), and operations landing in one watcher read batch
 *    collapse to a single delivered event (300 rapid writes delivered 20).
 *
 * `matchesWalkPath` rejects `note.md.tmp` and `dir1`, and
 * `src/serve/watch-service.ts:203-212` drops the event, so nothing reaches
 * `syncPaths`.
 *
 * The collection root is a real temp directory here because reconciliation
 * must read the directory's true final state; the watcher itself is still the
 * deterministic fake so no test depends on real event timing.
 */
const AMBIGUOUS_EVENT_WAIT_MS = 2000;
const RED_TEST_TIMEOUT_MS = 15_000;

/**
 * Captured linux/Bun-1.3.11 shape: an atomic save through a plain temp name
 * reports the SOURCE only. Destination `note.md` is never named.
 */
const LINUX_ATOMIC_CREATE_SEQUENCE: ReadonlyArray<
  readonly [string, string | null]
> = [["rename", "note.md.tmp"]];
/** Same shape for a replacement inside a pre-existing nested directory. */
const LINUX_ATOMIC_REPLACE_SEQUENCE: ReadonlyArray<
  readonly [string, string | null]
> = [["rename", "nested/note.md.tmp"]];
/**
 * Captured linux/Bun-1.3.11 shape for `rm -rf dir1`: only the directory is
 * named; the eligible files it held are never reported.
 */
const LINUX_DIRECTORY_DELETION_SEQUENCE: ReadonlyArray<
  readonly [string, string | null]
> = [["rename", "dir1"]];

function createSyncPathsProbe() {
  const batches: string[][] = [];
  let resolveFirst: ((batch: string[]) => void) | null = null;
  const firstBatch = new Promise<string[]>((resolve) => {
    resolveFirst = resolve;
  });

  defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
    const batch = [...relPaths];
    batches.push(batch);
    resolveFirst?.(batch);
    resolveFirst = null;
    return createSyncResult({
      filesProcessed: batch.length,
      filesUpdated: batch.length,
    });
  }) as typeof defaultSyncService.syncPaths;

  return {
    batches,
    /**
     * Resolves as soon as the watcher hands a batch to `syncPaths`. The
     * timeout is a hard failure bound so the RED case fails with a readable
     * assertion instead of hanging; it is not standing in for a settle signal.
     */
    async waitForBatch(): Promise<string[] | "NO_SYNC_WITHIN_TIMEOUT"> {
      const timeout = Bun.sleep(AMBIGUOUS_EVENT_WAIT_MS).then(
        () => "NO_SYNC_WITHIN_TIMEOUT" as const
      );
      return await Promise.race([firstBatch, timeout]);
    },
  };
}

/**
 * Store double exposing only the fn-114 task .2 seam the deletion
 * reconciliation needs: the ACTIVE indexed direct children of a directory.
 * This is how the test represents the indexed side — the half a purely
 * filesystem-shaped fixture cannot express, because a deleted file leaves no
 * trace on disk to enumerate.
 */
function createActiveChildrenStore(activeByDir: Record<string, string[]>): {
  store: unknown;
  calls: Array<{ collection: string; dirRelPath: string }>;
} {
  const calls: Array<{ collection: string; dirRelPath: string }> = [];
  return {
    calls,
    store: {
      // The watcher resolves a whole flush through the batched seam; `calls`
      // still records one entry per directory KEY so the assertions below stay
      // about which directories were consulted.
      listActiveDirectChildSourcePathsBatch(
        collection: string,
        dirRelPaths: string[]
      ) {
        const byDirectory = new Map<string, string[]>();
        for (const dirRelPath of dirRelPaths) {
          calls.push({ collection, dirRelPath });
          byDirectory.set(dirRelPath, activeByDir[dirRelPath] ?? []);
        }
        return Promise.resolve({ ok: true as const, value: byDirectory });
      },
    },
  };
}

function createFakeWatcherService(collection: Collection, store: unknown = {}) {
  let watcherCallback:
    | ((eventType: string, filename: string | null) => void)
    | undefined;

  const service = new CollectionWatchService({
    collections: [collection],
    eventBus: null,
    scheduler: null,
    store: store as never,
    watchFactory: ((
      _path: string,
      _options: { recursive: boolean },
      callback: WatchListener<string>
    ) => {
      watcherCallback = callback as typeof watcherCallback;
      return { close: () => undefined };
    }) as never,
  });

  return {
    service,
    emit: (sequence: ReadonlyArray<readonly [string, string | null]>): void => {
      for (const [eventType, filename] of sequence) {
        watcherCallback?.(eventType, filename);
      }
    },
  };
}

describe("CollectionWatchService ambiguous-event reconciliation (fn-114 RED)", () => {
  test(
    "syncs the final eligible file when an atomic create reports only the temp name",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-red-create-"));
      // Post-rename disk state: the atomic writer's destination exists, the
      // temp source does not, and an ineligible sibling must stay unindexed.
      await Bun.write(join(root, "note.md"), "# atomic\n");
      await Bun.write(join(root, "cover.png"), "not markdown");

      const probe = createSyncPathsProbe();
      const { service, emit } = createFakeWatcherService(
        createCollection("notes", root)
      );

      try {
        service.start();
        emit(LINUX_ATOMIC_CREATE_SEQUENCE);

        expect(await probe.waitForBatch()).toEqual(["note.md"]);
      } finally {
        await service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "syncs an atomically replaced existing eligible file reported only as a nested temp name",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-red-replace-"));
      await mkdir(join(root, "nested"), { recursive: true });
      // `nested/note.md` was already indexed; the atomic writer replaced its
      // contents, and only the temp source name was reported.
      await Bun.write(join(root, "nested", "note.md"), "# replaced\n");

      const probe = createSyncPathsProbe();
      const { service, emit } = createFakeWatcherService(
        createCollection("notes", root)
      );

      try {
        service.start();
        emit(LINUX_ATOMIC_REPLACE_SEQUENCE);

        expect(await probe.waitForBatch()).toEqual(["nested/note.md"]);
      } finally {
        await service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * Deletion coverage — the real stale-active condition, both halves.
   *
   * The existing green case above ("forwards eligible deletion paths for
   * inactive sync and one notification") passes because a SINGLE-FILE delete
   * names the deleted file on every platform we captured: `matchesWalkPath` is
   * filesystem-free (`src/ingestion/walker.ts:182-186`), so a deleted
   * `deleted.md` still passes eligibility and reaches `syncPaths`, which marks
   * it inactive. That case was never the production defect.
   *
   * The captured defect is a RECURSIVE DIRECTORY delete. On linux/Bun 1.3.11,
   * `rm -rf dir1` reports ONLY `dir1` — the eligible `dir1/a.md` and
   * `dir1/b.md` it held are never named. `matchesWalkPath("dir1")` rejects the
   * directory, the event is dropped, and both indexed documents stay ACTIVE
   * forever. That is the live stale-active condition.
   *
   * The indexed half cannot be expressed from disk state, because the deleted
   * files leave nothing on disk to enumerate. It is expressed through fn-114
   * task .2's store seam (`listActiveDirectChildSourcePaths`), which task .3
   * must call so the vanished children reconcile to inactive.
   */
  test(
    "deactivates indexed children when a recursive directory delete reports only the directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-red-delete-"));
      // Post-delete disk state: `dir1` and everything under it is gone; the
      // still-present eligible sibling at the root must not be disturbed.
      await Bun.write(join(root, "kept.md"), "# kept\n");

      const probe = createSyncPathsProbe();
      // Indexed side: both children of the vanished directory are still ACTIVE.
      const { store, calls } = createActiveChildrenStore({
        dir1: ["dir1/a.md", "dir1/b.md"],
      });
      const { service, emit } = createFakeWatcherService(
        createCollection("notes", root),
        store
      );

      try {
        service.start();
        emit(LINUX_DIRECTORY_DELETION_SEQUENCE);

        const batch = await probe.waitForBatch();
        expect(batch).not.toBe("NO_SYNC_WITHIN_TIMEOUT");
        // Both stale-active documents must be handed to `syncPaths`, which
        // marks a missing file inactive (`src/ingestion/sync.ts:1218-1267`).
        expect(batch).toContain("dir1/a.md");
        expect(batch).toContain("dir1/b.md");
        // R4: an ineligible event is not permission to index the directory
        // itself, nor to touch unrelated siblings that did not change.
        expect(batch).not.toContain("dir1");
        expect(batch).not.toContain("kept.md");
        // The indexed side must be consulted for the event's own directory.
        expect(calls).toContainEqual({
          collection: "notes",
          dirRelPath: "dir1",
        });
      } finally {
        await service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 task .3 — acceptance coverage for the bounded reconciliation path.
 *
 * These sit alongside the RED cases above and pin the behavior the RED tests do
 * not: that the exact-path flow is untouched, that repeated events coalesce
 * into ONE reconciliation batch (never asserted through delivered event counts,
 * which Bun collapses per watcher read batch), that the R12 direct-children
 * boundary is a tested limitation rather than a silent gap, and that every
 * degraded path fails closed, stays visible through the new diagnostics, and
 * leaves the watcher armed.
 */

interface ReconcileHarnessOptions {
  store?: unknown;
  eventBus?: { emit: (event: unknown) => void } | null;
  scheduler?: { notifySyncComplete: (relPaths: string[]) => void } | null;
  syncResult?: (relPaths: string[]) => CollectionSyncResult;
  /**
   * Awaited INSIDE `syncPaths`, before it resolves. That is how a test holds a
   * flush open and drives the "a later flush waited behind an in-flight sync"
   * window deterministically - the wait is released by an explicit signal, not
   * by a clock.
   */
  syncGate?: (relPaths: string[]) => Promise<void>;
  /**
   * Make EVERY fn-114 diagnostic observer throw after recording its event, so
   * a test can assert that a broken consumer cannot change watcher or flush
   * control flow (R7/R9).
   */
  throwFromDiagnostics?: boolean;
  /**
   * Replace the flush-time classification `stat` of a reported exact path, so
   * a test can act at exactly that awaited point (the classification window).
   */
  resolveVanishedPath?: (
    relPath: string,
    root: string
  ) => Promise<VanishedPathOutcome>;
  /**
   * Install NO `onReconcileFailed` observer, so a test can assert what the
   * watcher does when nothing is listening for failure causes - the cause
   * summary is skipped, but the fail-closed OUTCOME is not.
   */
  omitReconcileFailedObserver?: boolean;
}

function createReconcileHarness(
  collection: Collection,
  options: ReconcileHarnessOptions = {}
) {
  const batches: string[][] = [];
  const ambiguous: Array<{
    collection: string;
    directory: string | null;
    reason: string;
  }> = [];
  const started: Array<{ collection: string; directory: string }> = [];
  const completed: Array<{
    collection: string;
    directory: string;
    candidateCount: number;
    syncedCount: number;
  }> = [];
  const failed: Array<{
    collection: string;
    directory: string | null;
    stage: string;
    cause: unknown;
  }> = [];

  defaultSyncService.syncPaths = (async (_collection, _store, relPaths) => {
    batches.push([...relPaths]);
    await options.syncGate?.([...relPaths]);
    return (
      options.syncResult?.(relPaths) ??
      createSyncResult({
        filesProcessed: relPaths.length,
        filesUpdated: relPaths.length,
        files: relPaths.map((relPath) => ({ relPath, status: "updated" })),
      })
    );
  }) as typeof defaultSyncService.syncPaths;

  function explodeIfRequested(): void {
    if (options.throwFromDiagnostics) {
      throw new Error("diagnostic observer exploded");
    }
  }

  let notifySettled: (() => void) | null = null;
  let watcherCallback:
    | ((eventType: string, filename: string | null) => void)
    | undefined;

  const service = new CollectionWatchService({
    collections: [collection],
    eventBus: (options.eventBus ?? null) as never,
    scheduler: (options.scheduler ?? null) as never,
    store: (options.store ?? {}) as never,
    callbacks: {
      onSettled: () => {
        const resolve = notifySettled;
        notifySettled = null;
        resolve?.();
      },
      onAmbiguousEvent: (event) => {
        ambiguous.push(event);
        explodeIfRequested();
      },
      onReconcileStart: (event) => {
        started.push(event);
        explodeIfRequested();
      },
      onReconcileComplete: (event) => {
        completed.push(event);
        explodeIfRequested();
      },
      onReconcileFailed: options.omitReconcileFailedObserver
        ? undefined
        : (event) => {
            failed.push(event);
            explodeIfRequested();
          },
    },
    watchFactory: ((
      _path: string,
      _options: { recursive: boolean },
      callback: WatchListener<string>
    ) => {
      watcherCallback = callback as typeof watcherCallback;
      return { close: () => undefined };
    }) as never,
    resolveVanishedPath: options.resolveVanishedPath,
  });

  return {
    service,
    batches,
    ambiguous,
    started,
    completed,
    failed,
    emit(sequence: ReadonlyArray<readonly [string, string | null]>): void {
      for (const [eventType, filename] of sequence) {
        watcherCallback?.(eventType, filename);
      }
    },
    /**
     * Resolves on the watcher's own settle signal, so no assertion below is
     * timed against a fixed sleep. The race only bounds a hang.
     */
    async settle(): Promise<"settled" | "NO_SETTLE_WITHIN_TIMEOUT"> {
      const settled = new Promise<"settled">((resolve) => {
        notifySettled = () => resolve("settled");
      });
      return await Promise.race([
        settled,
        Bun.sleep(AMBIGUOUS_EVENT_WAIT_MS).then(
          () => "NO_SETTLE_WITHIN_TIMEOUT" as const
        ),
      ]);
    },
  };
}

/**
 * Store double recording every active-children lookup it is asked for.
 *
 * `calls` counts directory KEYS consulted; `roundTrips` counts invocations of
 * the store seam. The two are deliberately separate: the fix for the hint-cap
 * regression is that a whole debounce window's hints are discriminated in ONE
 * round trip, so key count may grow with event count while round trips must
 * not.
 */
function createRecordingStore(
  activeByDir: Record<string, string[]>,
  behavior: "ok" | "fail" = "ok"
) {
  const calls: string[] = [];
  const roundTrips: string[][] = [];
  return {
    calls,
    roundTrips,
    store: {
      listActiveDirectChildSourcePathsBatch(
        _collection: string,
        dirRelPaths: string[]
      ) {
        roundTrips.push([...dirRelPaths]);
        const byDirectory = new Map<string, string[]>();
        for (const dirRelPath of dirRelPaths) {
          calls.push(dirRelPath);
          byDirectory.set(dirRelPath, activeByDir[dirRelPath] ?? []);
        }
        return Promise.resolve(
          behavior === "ok"
            ? { ok: true as const, value: byDirectory }
            : {
                ok: false as const,
                error: { code: "QUERY_FAILED", message: "store offline" },
              }
        );
      },
    },
  };
}

describe("CollectionWatchService bounded reconciliation (fn-114 task .3)", () => {
  test(
    "keeps exact eligible events on the per-path flow with no directory work",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-exact-"));
      await Bun.write(join(root, "doc.md"), "# doc\n");
      await Bun.write(join(root, "neighbour.md"), "# neighbour\n");
      const { store, calls } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["change", "doc.md"]]);
        expect(await harness.settle()).toBe("settled");

        // Only the reported path syncs: no enumeration, no store lookup, and
        // the eligible neighbour on disk is never pulled in.
        expect(harness.batches).toEqual([["doc.md"]]);
        expect(calls).toEqual([]);
        expect(harness.started).toEqual([]);
        expect(harness.ambiguous).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "coalesces repeated ambiguous events for one directory into a single batch",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-coalesce-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store, calls, roundTrips } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Deliberately asserting RECONCILIATION WORK, not delivered events:
        // Bun collapses whatever lands in one watcher read batch (fn-114 .1
        // measured 300 rapid writes delivered as 20 events), so an event-count
        // assertion would measure the platform, not the debounce.
        for (let index = 0; index < 25; index += 1) {
          harness.emit([["rename", `note.md.tmp.${index}`]]);
        }
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["note.md"]]);
        expect(
          harness.ambiguous.filter(
            (event) => event.reason === "ineligible-path"
          )
        ).toHaveLength(25);

        // The load-bearing assertion: the final batch alone cannot show that
        // the WORK coalesced. 25 distinct temp names are ONE affected
        // directory, and every hint is discriminated against the indexed side
        // in ONE batched store round trip - so neither the filesystem work nor
        // the database work scales with the number of unique filenames.
        //
        // Measured on this test, 25 unique temp names:
        //   original (no coalescing): 26 enumerations, 25 store round trips
        //   hint cap of 8:             9 enumerations,  9 store round trips
        //                              (and a dropped hint could be a deleted
        //                               directory - the regression this fixes)
        //   batched discriminator:     1 enumeration,   1 store round trip
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        expect(roundTrips).toHaveLength(1);
        // Every hint IS asked about - no hint is ever dropped - but all 25 of
        // them plus the affected directory ride in that single round trip.
        expect(calls).toHaveLength(26);
        expect(calls).toContain("");
        expect(calls).toContain("note.md.tmp.24");

        // One reconciliation of the collection root, not 25.
        expect(
          harness.completed.filter((event) => event.directory === "")
        ).toHaveLength(1);
        expect(harness.completed[0]).toMatchObject({
          collection: "notes",
          directory: "",
          candidateCount: 1,
          syncedCount: 1,
        });
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps a deleted-directory hint behind a burst of unique temp-name hints",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-hint-burst-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store, calls, roundTrips } = createRecordingStore({
        dir1: ["dir1/a.md"],
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // The exact shape that broke under a fixed hint budget: enough unique
        // ambiguous temp names to exhaust any per-directory cap, and THEN the
        // recursive-directory-delete hint. At queue time `dir1` is
        // indistinguishable from the eight names before it - all are simply
        // paths that no longer exist - so any budget that drops "one more
        // ambiguous hint" can drop this one, and `dir1/a.md` then stays active
        // until a manual `gno update`.
        for (let index = 0; index < 8; index += 1) {
          harness.emit([["rename", `note.md.tmp.${index}`]]);
        }
        harness.emit([["rename", "dir1"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toHaveLength(1);
        // R12: the deleted directory's indexed child reaches `syncPaths`, which
        // marks the missing file inactive.
        expect(harness.batches[0]).toContain("dir1/a.md");
        // The temp-name hints still resolve to their affected directory, so the
        // atomically saved sibling is picked up in the SAME batch.
        expect(harness.batches[0]).toContain("note.md");
        expect(harness.batches[0]).not.toContain("dir1");
        // ...and the hint that survived cost nothing extra: one round trip for
        // all nine hints plus the affected directory, and one enumeration each
        // for the deleted directory and the affected directory.
        expect(roundTrips).toHaveLength(1);
        expect(calls).toContain("dir1");
        expect(harness.started).toHaveLength(2);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "deactivates only the DIRECT indexed children of a deleted directory (R12 boundary)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-r12-"));
      const { store, calls } = createRecordingStore({
        dir1: ["dir1/a.md"],
        "dir1/sub": ["dir1/sub/deep.md"],
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["dir1/a.md"]]);
        // DOCUMENTED LIMITATION (R12): staying directory-bounded means a
        // document nested deeper than one level below the deleted directory is
        // NOT deactivated here and still needs `gno update`. Asserted so the
        // boundary is tested rather than silently assumed.
        expect(harness.batches[0]).not.toContain("dir1/sub/deep.md");
        expect(calls).not.toContain("dir1/sub");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "dedupes an exact event and its ambiguous sibling into one batch",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-dedupe-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store } = createRecordingStore({ "": ["note.md"] });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([
          ["rename", "note.md"],
          ["rename", "note.md.tmp"],
        ]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps suppressed application writes suppressed inside a reconciled directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-"));
      await Bun.write(join(root, "note.md"), "# written by gno\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "note.md"));
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reports a store failure and infers no deactivation from it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-store-fail-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store } = createRecordingStore({}, "fail");
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        // The disk side still works, so the atomic save is picked up; nothing
        // is deactivated, because the indexed side never answered.
        expect(harness.batches).toEqual([["note.md"]]);
        expect(harness.failed.some((event) => event.stage === "store")).toBe(
          true
        );
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test.skipIf(process.getuid?.() === 0)(
    "fails closed on an unreadable directory, reports it, and stays armed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-eacces-"));
      await mkdir(join(root, "locked"), { recursive: true });
      await Bun.write(join(root, "locked", "note.md"), "# locked\n");
      await Bun.write(join(root, "after.md"), "# after\n");
      await chmod(join(root, "locked"), 0o000);
      const { store, calls } = createRecordingStore({
        locked: ["locked/note.md"],
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "locked"]]);
        expect(await harness.settle()).toBe("settled");

        // An unreadable directory is never read as an authoritative empty
        // directory: nothing syncs and nothing deactivates, even though the
        // indexed side positively reported `locked/note.md` as still active.
        // That is the stronger statement - the store answer was in hand and
        // the failed enumeration VETOED it - and it is the assertion that
        // matters, since the batched discriminator necessarily consults the
        // indexed side before it knows whether a hint is a directory at all.
        expect(calls).toContain("locked");
        expect(harness.batches).toEqual([]);
        expect(harness.failed).toHaveLength(1);
        expect(harness.failed[0]).toMatchObject({
          collection: "notes",
          directory: "locked",
          stage: "enumerate",
        });

        // The watcher is still armed after the failure.
        harness.emit([["change", "after.md"]]);
        expect(await harness.settle()).toBe("settled");
        expect(harness.batches).toEqual([["after.md"]]);
      } finally {
        await chmod(join(root, "locked"), 0o700).catch(() => undefined);
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops a null filename without throwing and reports it as ambiguous",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-null-"));
      await Bun.write(join(root, "note.md"), "# note\n");
      const { store, calls } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        expect(() => harness.emit([["change", null]])).not.toThrow();

        // Deterministic, no sleep: a dropped event queues nothing at all.
        expect(harness.service.getState().queuedCollections).toEqual([]);
        expect(harness.ambiguous).toEqual([
          { collection: "notes", directory: null, reason: "missing-filename" },
        ]);
        expect(calls).toEqual([]);
        expect(harness.batches).toEqual([]);

        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");
        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "recovers with a full sync when the configuration changes DURING enumeration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-mid-enum-"));
      // Only `.txt` exists on disk. Under the ORIGINAL `**/*.md` rules the
      // reconciliation legitimately produces nothing, so an empty batch must
      // not be mistaken for "no work": the rules changed while the async
      // enumeration was in flight, and `note.txt` is newly eligible.
      await Bun.write(join(root, "note.txt"), "# txt\n");
      const syncCollection = mock(async () => createSyncResult());
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let swapped = false;
      // The store seam is the controllable point INSIDE the enumeration: it is
      // awaited half-way through reconciling a directory.
      const store = {
        listActiveDirectChildSourcePaths() {
          if (!swapped) {
            swapped = true;
            const retargeted = createCollection("notes", root);
            retargeted.pattern = "**/*.txt";
            harness?.service.updateCollections([retargeted]);
          }
          return Promise.resolve({ ok: true as const, value: [] });
        },
      };
      harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.txt.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        // The old rules matched nothing, so no bounded batch was ever synced.
        expect(harness.batches).toEqual([]);
        expect(swapped).toBe(true);
        // Generation drift during enumeration must still reach the
        // full-collection recovery; otherwise `note.txt` is never discovered.
        expect(syncCollection).toHaveBeenCalledTimes(1);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "isolates throwing diagnostic observers from the watcher callback (R7/R9)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-throwing-obs-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        throwFromDiagnostics: true,
      });

      try {
        harness.service.start();

        // Null-filename branch: the observer throws before the early return.
        expect(() => harness.emit([["change", null]])).not.toThrow();
        // Ineligible-filename branch: the observer throws BEFORE the dirty
        // directory is queued, so an unguarded call would also silently cancel
        // the reconciliation, not just escape the watcher callback.
        expect(() => harness.emit([["rename", "note.md.tmp"]])).not.toThrow();

        expect(await harness.settle()).toBe("settled");
        // Reconciliation still happened despite every observer throwing.
        expect(harness.batches).toEqual([["note.md"]]);
        expect(harness.ambiguous).toHaveLength(2);
        // One enumeration: the `note.md.tmp` hint has no active indexed
        // children, so it never reaches the disk and only the affected
        // directory is reconciled.
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops queued reconciliation when the collection root changes before the flush",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-root-change-"));
      const moved = await mkdtemp(join(tmpdir(), "gno-watch-root-moved-"));
      await Bun.write(join(root, "note.md"), "# stale\n");
      const { store, calls } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(harness.service.getState().queuedCollections).toEqual(["notes"]);

        harness.service.updateCollections([createCollection("notes", moved)]);
        expect(harness.service.getState().queuedCollections).toEqual([]);

        await Bun.sleep(350);
        expect(harness.batches).toEqual([]);
        expect(calls).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "honors collection filters changed before a queued reconciliation flushes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-live-rules-"));
      await mkdir(join(root, "drafts"), { recursive: true });
      await Bun.write(join(root, "drafts", "note.md"), "# draft\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "drafts/note.md.tmp"]]);
        const excluded = createCollection("notes", root);
        excluded.exclude = ["drafts"];
        harness.service.updateCollections([excluded]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "emits nothing for unchanged neighbours pulled into a reconciliation batch",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-neighbour-"));
      await Bun.write(join(root, "changed.md"), "# changed\n");
      await Bun.write(join(root, "neighbour.md"), "# unchanged\n");
      const emit = mock((_event: unknown) => undefined);
      const notifySyncComplete = mock((_relPaths: string[]) => undefined);
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        eventBus: { emit },
        scheduler: { notifySyncComplete },
        syncResult: (relPaths) =>
          createSyncResult({
            filesProcessed: relPaths.length,
            filesUpdated: 1,
            filesUnchanged: relPaths.length - 1,
            files: relPaths.map((relPath) => ({
              relPath,
              status: relPath === "changed.md" ? "updated" : "unchanged",
            })),
          }),
      });

      try {
        harness.service.start();
        harness.emit([["rename", "changed.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["changed.md", "neighbour.md"]]);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0]?.[0]).toMatchObject({
          relPath: "changed.md",
        });
        expect(notifySyncComplete).toHaveBeenCalledTimes(1);
        expect(notifySyncComplete).toHaveBeenCalledWith(["changed.md"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reconciles a deleted record container through its physical source path (R10)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-records-"));
      const collection = createCollection("notes", root);
      collection.pattern = "**/*.jsonl";
      collection.include = [".jsonl"];
      // The store seam returns the DISTINCT effective source path
      // (COALESCE(record_source_path, rel_path)), so every logical record
      // derived from the container reconciles through the one physical path.
      const { store } = createRecordingStore({
        records: ["records/export.jsonl"],
      });
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        harness.emit([["rename", "records"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["records/export.jsonl"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "causes no unbounded collection work for unrelated excluded-path noise",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-noise-"));
      await mkdir(join(root, ".obsidian"), { recursive: true });
      await Bun.write(join(root, "note.md"), "# note\n");
      const syncCollection = mock(async () => createSyncResult());
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;
      const collection = createCollection("notes", root);
      collection.exclude = [".obsidian"];
      const { store, calls } = createRecordingStore({});
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        harness.emit([
          ["change", ".obsidian/workspace.json"],
          ["change", ".obsidian/.sync.lock"],
        ]);

        // Excluded and dot-prefixed areas are never walked by a full sync
        // either, so they queue no reconciliation at all - deterministic,
        // no sleep required.
        expect(harness.service.getState().queuedCollections).toEqual([]);
        expect(harness.batches).toEqual([]);
        expect(calls).toEqual([]);
        expect(syncCollection).not.toHaveBeenCalled();
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * Directory pruning must not be STRICTER than the walk.
   *
   * An exclusion can match a directory's own NAME without covering anything
   * beneath it: with `exclude: ["*.md"]` a directory literally called `foo.md`
   * matches, but `FileWalker.walk` still indexes `foo.md/child.txt`, because
   * the walker asks the same file-level question about the FILE. Pruning the
   * directory on the file-level answer therefore removes from reconciliation a
   * subtree that is genuinely indexed - and a recursive delete of `foo.md/`
   * reports only the bare directory (or one arbitrary child), so `child.txt`
   * is never named by an event either and stays active and searchable with
   * nothing on disk behind it.
   *
   * Against 538e3047 the reported path is pruned by
   * `matchesCollectionExclusion`, no hint is retained, no descendant lookup
   * happens and `harness.batches` is empty - so both assertions below fail.
   * Discriminating, not a direction pin.
   */
  test(
    "reconciles a removed directory whose NAME matches a file-level exclusion",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-excl-name-"));
      // Post-delete disk state: `foo.md/` and its child are already gone.
      const collection = createCollection("notes", root);
      collection.pattern = "**/*";
      collection.exclude = ["*.md"];

      const { store, descendantCalls } = createSubtreeStore({
        descendants: { "foo.md": ["foo.md/child.txt"] },
      });
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        harness.emit([["rename", "foo.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(descendantCalls).toContain("foo.md");
        expect(harness.batches.flat()).toContain("foo.md/child.txt");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * The counterweight to the test above: an exclusion that DOES cover its
   * descendants still prunes, so the bound on work for excluded-tree noise is
   * unchanged and `node_modules` is never scanned.
   *
   * This one is deliberately NOT discriminating - it passes against 538e3047
   * too. It exists to pin that the fix did not over-correct into reconciling
   * every excluded tree.
   */
  test(
    "still prunes a directory whose exclusion covers the whole subtree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-excl-covering-"));
      await mkdir(join(root, "sub"), { recursive: true });
      const collection = createCollection("notes", root);
      collection.exclude = ["node_modules"];
      const { store, directCalls, descendantCalls } = createSubtreeStore({
        descendants: {
          "sub/node_modules": ["sub/node_modules/pkg/readme.md"],
        },
      });
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        // Events entirely inside the excluded tree queue nothing at all -
        // deterministic, no sleep required.
        harness.emit([
          ["change", "node_modules/pkg/readme.md"],
          ["rename", "node_modules/pkg"],
        ]);
        expect(harness.service.getState().queuedCollections).toEqual([]);

        // A removed excluded directory reported by name is the exact mirror of
        // the `foo.md` case above - and here the exclusion DOES cover the
        // subtree, so it is still pruned: no hint, no descendant lookup, no
        // scan of the excluded tree.
        harness.emit([["rename", "sub/node_modules"]]);
        expect(await harness.settle()).toBe("settled");

        expect(descendantCalls).not.toContain("sub/node_modules");
        expect(directCalls).not.toContain("sub/node_modules");
        expect(harness.batches.flat()).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * The consequence that matters when coverage is INFERRED FROM SAMPLES rather
   * than proven: a stranded document.
   *
   * `foo/**` + `/_[^x]*` matches the directory `foo/_a` and matches any deeper
   * `_`-prefixed name - including the two synthetic probe segments the previous
   * rule asked about - yet it does NOT match `foo/_a/x.md`, which the walker
   * indexes. Against b4950b13 the sampling answered "covers the subtree",
   * `foo/_a` was pruned at queue time, no hint was retained, no descendant
   * lookup happened, `harness.batches` is empty, and `x.md` stays active and
   * searchable with nothing on disk behind it. Both assertions below fail there.
   */
  test(
    "reconciles a removed directory a sampled glob only appeared to cover",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-excl-sample-"));
      // Post-delete disk state: `foo/_a/` and its child are already gone.
      const collection = createCollection("notes", root);
      collection.pattern = "**/*";
      collection.exclude = ["foo/**/_[^x]*"];

      const { store, descendantCalls } = createSubtreeStore({
        descendants: { "foo/_a": ["foo/_a/x.md"] },
      });
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        harness.emit([["rename", "foo/_a"]]);
        expect(await harness.settle()).toBe("settled");

        expect(descendantCalls).toContain("foo/_a");
        expect(harness.batches.flat()).toContain("foo/_a/x.md");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * The exact-root spelling of a covering exclusion. `node_modules/` covers
   * every strict descendant of `node_modules` while deliberately not matching
   * the bare path `node_modules`, so coverage may not be gated on the
   * directory's own match.
   *
   * Against b4950b13 the trailing slash matched nothing at all: the gate
   * returned false, the directory was reconcilable, and the boundary event did
   * a descendant lookup and parent enumeration. `descendantCalls` contains
   * `sub/node_modules` there, so this is discriminating - and it pins that the
   * amplification bound covers this spelling too.
   */
  test(
    "still prunes for an exact-root `node_modules/` exclusion",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-excl-root-"));
      await mkdir(join(root, "sub"), { recursive: true });
      const collection = createCollection("notes", root);
      collection.exclude = ["node_modules/"];
      const { store, directCalls, descendantCalls } = createSubtreeStore({
        descendants: {
          "sub/node_modules": ["sub/node_modules/pkg/readme.md"],
        },
      });
      const harness = createReconcileHarness(collection, { store });

      try {
        harness.service.start();
        harness.emit([
          ["change", "node_modules/pkg/readme.md"],
          ["rename", "node_modules/pkg"],
        ]);
        expect(harness.service.getState().queuedCollections).toEqual([]);

        harness.emit([["rename", "sub/node_modules"]]);
        expect(await harness.settle()).toBe("settled");

        expect(descendantCalls).not.toContain("sub/node_modules");
        expect(directCalls).not.toContain("sub/node_modules");
        expect(harness.batches.flat()).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * R6 - the enumeration window. Candidates are resolved BEFORE an async
   * enumeration and handed to `syncPaths` AFTER it, so the configuration they
   * were resolved against can disappear or move in between. Checking only for
   * disposal there let a removed collection's stale batch sync anyway, and a
   * moved root sync stale candidates before recovering.
   *
   * Both cases mutate the configuration from inside the awaited store seam, the
   * same controllable point the generation-drift test above uses.
   */
  test(
    "drops the batch when the collection is REMOVED during enumeration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-mid-removed-"));
      // An eligible file the enumeration will happily resolve as a candidate.
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const syncCollection = mock(async () => createSyncResult());
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let removed = false;
      const store = {
        listActiveDirectChildSourcePaths() {
          if (!removed) {
            removed = true;
            harness?.service.updateCollections([]);
          }
          return Promise.resolve({ ok: true as const, value: [] });
        },
      };
      harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(removed).toBe(true);
        // The collection no longer exists: nothing may be synced for it, by
        // either the bounded path or the full-collection recovery.
        expect(harness.batches).toEqual([]);
        expect(syncCollection).not.toHaveBeenCalled();
        // The reconciliation still started, so it still owes exactly one
        // terminal outcome - a completion reporting that nothing was synced.
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        expect(harness.completed).toEqual([
          {
            collection: "notes",
            directory: "",
            candidateCount: 1,
            syncedCount: 0,
          },
        ]);
        expect(harness.failed).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops the batch when the collection ROOT changes during enumeration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-mid-root-old-"));
      const moved = await mkdtemp(join(tmpdir(), "gno-watch-mid-root-new-"));
      // Same relative name under both roots: syncing the stale candidate would
      // silently resolve against whichever root `syncPaths` is handed.
      await Bun.write(join(root, "note.md"), "# old root\n");
      await Bun.write(join(moved, "note.md"), "# new root\n");
      // Typed parameter so the recovery target itself can be asserted.
      const syncCollection = mock(async (_collection: Collection) =>
        createSyncResult()
      );
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let swapped = false;
      const store = {
        listActiveDirectChildSourcePaths() {
          if (!swapped) {
            swapped = true;
            harness?.service.updateCollections([
              createCollection("notes", moved),
            ]);
          }
          return Promise.resolve({ ok: true as const, value: [] });
        },
      };
      harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(swapped).toBe(true);
        // The bounded candidates were enumerated under the OLD root, so they
        // are synced against neither root.
        expect(harness.batches).toEqual([]);
        // A moved root is still generation drift, so the pre-existing
        // full-collection recovery runs - against the CURRENT collection.
        expect(syncCollection).toHaveBeenCalledTimes(1);
        expect(syncCollection.mock.calls[0]?.[0]).toMatchObject({
          name: "notes",
          path: moved,
        });
        expect(harness.completed).toEqual([
          {
            collection: "notes",
            directory: "",
            candidateCount: 1,
            syncedCount: 0,
          },
        ]);
        expect(harness.failed).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * R6 - the CLASSIFICATION window. `#widenVanishedExactPaths` stats every
   * reported exact path before anything is synced, which is a second async
   * window in exactly the same sense as enumeration. It is reached even when
   * NO directory is dirty (a batch of plain exact paths), so a drift guard that
   * lives inside the enumeration branch never runs for it and the stale exact
   * paths sync against a configuration that has already moved.
   *
   * Each case mutates the configuration from inside the awaited classification
   * seam, the same controllable-point technique the enumeration-window tests
   * use for the store seam.
   */
  test(
    "drops exact paths when the collection is REMOVED during classification",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-class-removed-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const syncCollection = mock(async () => createSyncResult());
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let removed = false;
      const harnessOptions = {
        store: createRecordingStore({}).store,
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => {
          if (!removed) {
            removed = true;
            harness?.service.updateCollections([]);
          }
          // The path is still there: no directory is widened, so this batch
          // NEVER enters the enumeration branch.
          return { status: "present" as const, isDirectory: false };
        },
      };
      harness = createReconcileHarness(
        createCollection("notes", root),
        harnessOptions
      );

      try {
        harness.service.start();
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(removed).toBe(true);
        // Nothing is synced for a collection that no longer exists - not the
        // stale exact path, and not a recovery against a missing collection.
        expect(harness.batches).toEqual([]);
        expect(syncCollection).not.toHaveBeenCalled();
        expect(harness.started).toEqual([]);
        expect(harness.completed).toEqual([]);
        expect(harness.failed).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops exact paths when the collection ROOT changes during classification",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-class-root-old-"));
      const moved = await mkdtemp(join(tmpdir(), "gno-watch-class-root-new-"));
      // Same relative name under both roots: syncing the stale exact path
      // would silently resolve against whichever root `syncPaths` is handed.
      await Bun.write(join(root, "note.md"), "# old root\n");
      await Bun.write(join(moved, "note.md"), "# new root\n");
      const syncCollection = mock(async (_collection: Collection) =>
        createSyncResult()
      );
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let swapped = false;
      const harnessOptions = {
        store: createRecordingStore({}).store,
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => {
          if (!swapped) {
            swapped = true;
            harness?.service.updateCollections([
              createCollection("notes", moved),
            ]);
          }
          return { status: "present" as const, isDirectory: false };
        },
      };
      harness = createReconcileHarness(
        createCollection("notes", root),
        harnessOptions
      );

      try {
        harness.service.start();
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(swapped).toBe(true);
        // Synced against neither root.
        expect(harness.batches).toEqual([]);
        // A moved root is generation drift, so the full-collection recovery
        // runs - against the CURRENT collection.
        expect(syncCollection).toHaveBeenCalledTimes(1);
        expect(syncCollection.mock.calls[0]?.[0]).toMatchObject({
          name: "notes",
          path: moved,
        });
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops exact paths when the CONFIGURATION drifts during classification",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-class-drift-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const syncCollection = mock(async (_collection: Collection) =>
        createSyncResult()
      );
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      let harness: ReturnType<typeof createReconcileHarness> | null = null;
      let drifted = false;
      const harnessOptions = {
        store: createRecordingStore({}).store,
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => {
          if (!drifted) {
            drifted = true;
            // Same root, different rules. `note.md` stays eligible under BOTH,
            // so the live-rules recheck cannot filter it out - only the drift
            // guard can stop it, which is what makes this discriminating.
            const retuned = createCollection("notes", root);
            retuned.exclude = ["archive"];
            harness?.service.updateCollections([retuned]);
          }
          return { status: "present" as const, isDirectory: false };
        },
      };
      harness = createReconcileHarness(
        createCollection("notes", root),
        harnessOptions
      );

      try {
        harness.service.start();
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(drifted).toBe(true);
        // No stale bounded sync under the OLD sync options...
        expect(harness.batches).toEqual([]);
        // ...and the full-collection recovery still runs, so `note.md` is
        // reindexed under the CURRENT configuration instead.
        expect(syncCollection).toHaveBeenCalledTimes(1);
        expect(syncCollection.mock.calls[0]?.[0]).toMatchObject({
          name: "notes",
          path: root,
          exclude: ["archive"],
        });
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "leaves an UNDRIFTED classification flush exactly as it was",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-class-stable-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const syncCollection = mock(async () => createSyncResult());
      defaultSyncService.syncCollection =
        syncCollection as typeof defaultSyncService.syncCollection;

      const harness = createReconcileHarness(createCollection("notes", root), {
        store: createRecordingStore({}).store,
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => ({
          status: "present" as const,
          isDirectory: false,
        }),
      });

      try {
        harness.service.start();
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        // The unconditional revalidation must not over-drop: with no drift the
        // ordinary bounded flush is untouched, and no recovery is provoked.
        expect(harness.batches).toEqual([["note.md"]]);
        expect(syncCollection).not.toHaveBeenCalled();
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * R7 - exactly one terminal outcome per started reconciliation. Reporting
   * completion before the shared `syncPaths` produced BOTH "completed" and
   * "failed" for the same directory when that sync then failed; filtering empty
   * outcomes away produced NEITHER for a successful no-op.
   */
  test(
    "reports a sync failure without also reporting the directory as completed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-sync-fail-"));
      await Bun.write(join(root, "note.md"), "# atomic\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });
      const attempted: string[][] = [];
      const syncFailure = new Error("sync stage exploded");
      defaultSyncService.syncPaths = (async (
        _collection,
        _store,
        relPaths: string[]
      ) => {
        attempted.push([...relPaths]);
        throw syncFailure;
      }) as typeof defaultSyncService.syncPaths;

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        // The reconciliation did reach the sync stage, and the sync failed.
        expect(attempted).toEqual([["note.md"]]);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        expect(harness.failed).toEqual([
          {
            collection: "notes",
            directory: "",
            stage: "sync",
            cause: syncFailure,
          },
        ]);
        // The load-bearing assertion: no completion for a directory whose batch
        // failed downstream.
        expect(harness.completed).toEqual([]);

        // A failed sync leaves the watcher armed.
        defaultSyncService.syncPaths = (async (
          _collection,
          _store,
          relPaths: string[]
        ) => {
          harness.batches.push([...relPaths]);
          return createSyncResult({
            filesProcessed: relPaths.length,
            filesUpdated: relPaths.length,
          });
        }) as typeof defaultSyncService.syncPaths;
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");
        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reports a successful zero-candidate reconciliation as completed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-empty-ok-"));
      // Nothing eligible on disk and nothing active indexed: the reconciliation
      // succeeds and legitimately has no work. That is still an OUTCOME.
      await Bun.write(join(root, "cover.png"), "not markdown");
      const { store, calls } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(calls).toContain("");
        expect(harness.batches).toEqual([]);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        // Neither a completion nor a failure was emitted for this directory
        // before the fix: the reconciliation simply vanished after its start.
        expect(harness.completed).toEqual([
          {
            collection: "notes",
            directory: "",
            candidateCount: 0,
            syncedCount: 0,
          },
        ]);
        expect(harness.failed).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 follow-up - full-subtree deletion reconciliation.
 *
 * The original design split events into "ineligible => hint" and "eligible =>
 * authoritative". Bun 1.3.14 disproved the second half. Measured on the
 * the reporter's Linux/ext4 VPS with real inotify, `rm -rf dir1/` holding
 * `a.md` and `b.md` reports:
 *
 *   Bun 1.3.11 -> [["rename", "dir1"]]      (the directory)
 *   Bun 1.3.14 -> [["rename", "dir1/b.md"]] (ONE arbitrary child; a container
 *                                            on the same version reported
 *                                            `dir1/a.md` instead)
 *
 * The reported child is ELIGIBLE, so it took the exact-path fast path, no
 * reconciliation ran, and every unnamed sibling stayed active forever - live,
 * `a.md` vanished from search while `b.md` was still retrievable 30s later.
 *
 * The rule these tests pin: an event naming a path that no longer EXISTS is one
 * sample of a larger removal, so the watcher walks up to the shallowest removed
 * ancestor and reconciles that whole subtree. A path that still exists is
 * unchanged - the live-edit hot path never widens.
 */

/**
 * Store double exposing BOTH indexed seams: direct children (a surviving
 * directory) and descendants (a removed subtree). `descendantCalls` records
 * every subtree lookup so a test can prove a live edit never triggers one.
 */
function createSubtreeStore(options: {
  direct?: Record<string, string[]>;
  descendants?: Record<string, string[]>;
  /** Every active source path in the collection (the removed-root answer). */
  all?: string[];
  /** Make the descendant seam fail, as a store outage would. */
  descendantsFail?: boolean;
  /**
   * Runs inside the FIRST store round trip of a flush - after the reported
   * path has been classified against the disk, before the directory is
   * enumerated. That is exactly the window in which a removed directory can be
   * recreated, so this is how a test drives that race deterministically.
   */
  duringLookup?: () => Promise<void>;
}) {
  const direct = options.direct ?? {};
  const descendants = options.descendants ?? {};
  const directCalls: string[] = [];
  const descendantCalls: string[] = [];
  const allCalls: string[] = [];
  // `*Calls` count directory KEYS consulted; `*RoundTrips` count invocations of
  // the seam. The two are deliberately separate: a debounce window may consult
  // more keys as it learns more, but it must never spend more round trips.
  const directRoundTrips: string[][] = [];
  const descendantRoundTrips: string[][] = [];
  const descendantError = {
    ok: false as const,
    error: { code: "QUERY_FAILED", message: "store offline" },
  };

  return {
    directCalls,
    descendantCalls,
    allCalls,
    directRoundTrips,
    descendantRoundTrips,
    store: {
      async listActiveDirectChildSourcePathsBatch(
        _collection: string,
        dirRelPaths: string[]
      ) {
        await options.duringLookup?.();
        directRoundTrips.push([...dirRelPaths]);
        const byDirectory = new Map<string, string[]>();
        for (const dirRelPath of dirRelPaths) {
          directCalls.push(dirRelPath);
          byDirectory.set(dirRelPath, direct[dirRelPath] ?? []);
        }
        return { ok: true as const, value: byDirectory };
      },
      listActiveSourcePaths(collection: string) {
        allCalls.push(collection);
        return Promise.resolve({
          ok: true as const,
          value: options.all ?? [],
        });
      },
      listActiveDescendantSourcePaths(_collection: string, dirRelPath: string) {
        descendantCalls.push(dirRelPath);
        return Promise.resolve(
          options.descendantsFail
            ? descendantError
            : {
                ok: true as const,
                value: descendants[dirRelPath] ?? [],
              }
        );
      },
      listActiveDescendantSourcePathsBatch(
        _collection: string,
        dirRelPaths: string[]
      ) {
        descendantRoundTrips.push([...dirRelPaths]);
        const byDirectory = new Map<string, string[]>();
        for (const dirRelPath of dirRelPaths) {
          descendantCalls.push(dirRelPath);
          byDirectory.set(dirRelPath, descendants[dirRelPath] ?? []);
        }
        return Promise.resolve(
          options.descendantsFail
            ? descendantError
            : { ok: true as const, value: byDirectory }
        );
      },
    },
  };
}

describe("CollectionWatchService full-subtree deletion reconciliation", () => {
  test(
    "deactivates every sibling when the delete names one arbitrary child",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-child-"));
      // Post-delete disk state: `dir1` and both its files are gone; the
      // untouched sibling directory and root file are still there.
      await mkdir(join(root, "dir2"), { recursive: true });
      await Bun.write(join(root, "dir2", "other.md"), "# other\n");
      await Bun.write(join(root, "keep.md"), "# keep\n");

      const { store, descendantCalls } = createSubtreeStore({
        descendants: { dir1: ["dir1/a.md", "dir1/b.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // The production 1.3.14 shape: ONE arbitrary eligible child, nothing
        // else. Whether it is `a.md` or `b.md` is not stable, so neither may be
        // the thing correctness depends on.
        harness.emit([["rename", "dir1/b.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toHaveLength(1);
        const batch = harness.batches[0] ?? [];
        // The UNNAMED sibling is the whole point: before the fix it stayed
        // active forever because the event never mentioned it.
        expect(batch).toContain("dir1/a.md");
        expect(batch).toContain("dir1/b.md");
        // Bounded: the untouched sibling directory and the root file are not
        // dragged in.
        expect(batch).not.toContain("dir2/other.md");
        expect(batch).not.toContain("keep.md");
        expect(descendantCalls).toEqual(["dir1"]);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "dir1" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "walks up to the removed ancestor when the delete names a deeply nested child",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-deep-"));
      await Bun.write(join(root, "keep.md"), "# keep\n");

      const { store, descendantCalls } = createSubtreeStore({
        descendants: {
          dir1: ["dir1/a.md", "dir1/sub/c.md", "dir1/sub/deeper/d.md"],
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // The reported child sits two levels down, and its own parent is gone
        // too - a single `dirname` would reconcile `dir1/sub` and strand
        // `dir1/a.md`.
        harness.emit([["rename", "dir1/sub/c.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        expect(batch).toContain("dir1/a.md");
        expect(batch).toContain("dir1/sub/c.md");
        // No depth limit: this is what removes the old "direct children only"
        // limitation rather than moving it one level down.
        expect(batch).toContain("dir1/sub/deeper/d.md");
        expect(batch).not.toContain("keep.md");
        // The SHALLOWEST removed ancestor is the reconciled area.
        expect(descendantCalls).toEqual(["dir1"]);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "dir1" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps a single-file delete inside its surviving directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-single-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await mkdir(join(root, "dir2"), { recursive: true });
      // `dir1/gone.md` was deleted; its directory and neighbour survive.
      await Bun.write(join(root, "dir1", "neighbour.md"), "# neighbour\n");
      await Bun.write(join(root, "dir2", "other.md"), "# other\n");

      const { store, directCalls, descendantCalls } = createSubtreeStore({
        direct: { dir1: ["dir1/gone.md", "dir1/neighbour.md"] },
        descendants: { dir1: ["dir1/gone.md", "dir1/neighbour.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/gone.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The deleted file still reaches `syncPaths`, which marks it inactive.
        expect(batch).toContain("dir1/gone.md");
        // The vanished path is asked about ONCE, on the discriminator seam,
        // because an eligible name proves nothing about whether it was a file
        // or a directory. It has no indexed descendants, so widening collapses
        // to the directory it lived in - which survived - and nothing outside
        // that directory is touched. The parent is never queried on the
        // subtree seam: it was never observed missing.
        expect(descendantCalls).toEqual(["dir1/gone.md"]);
        expect(directCalls).toEqual(["dir1", "dir1/gone.md"]);
        expect(batch).not.toContain("dir2/other.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "dir1" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "never widens a live edit of a file that still exists",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-edit-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await Bun.write(join(root, "dir1", "doc.md"), "# doc\n");
      await Bun.write(join(root, "dir1", "neighbour.md"), "# neighbour\n");

      const { store, directCalls, descendantCalls, descendantRoundTrips } =
        createSubtreeStore({
          direct: { dir1: ["dir1/doc.md", "dir1/neighbour.md"] },
          descendants: { dir1: ["dir1/doc.md", "dir1/neighbour.md"] },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["change", "dir1/doc.md"]]);
        expect(await harness.settle()).toBe("settled");

        // R1's hot path, intact: the file exists, so the event named the whole
        // change. One path synced, no enumeration, and no reconciliation
        // diagnostics at all.
        expect(harness.batches).toEqual([["dir1/doc.md"]]);
        expect(directCalls).toEqual([]);
        expect(harness.started).toEqual([]);
        expect(harness.ambiguous).toEqual([]);
        // The one thing the hot path now spends: the reported path rides the
        // flush's batched REPLACEMENT probe - "is anything indexed beneath a
        // name that is now a plain file?" - which is what catches an indexed
        // directory deleted and rewritten as a document in one window. It is
        // asked once per window, not once per event, and it answers "nothing"
        // here, so nothing above changes: no widening, no enumeration, no
        // direct-children query, no reconciliation.
        expect(descendantCalls).toEqual(["dir1/doc.md"]);
        expect(descendantRoundTrips).toHaveLength(1);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "leaves an untouched sibling directory entirely alone",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-sibling-"));
      await mkdir(join(root, "dir2", "sub"), { recursive: true });
      await Bun.write(join(root, "dir2", "sub", "other.md"), "# other\n");

      const { store, directCalls, descendantCalls } = createSubtreeStore({
        direct: { dir2: [], "dir2/sub": ["dir2/sub/other.md"] },
        descendants: {
          dir1: ["dir1/a.md", "dir1/sub/c.md"],
          dir2: ["dir2/sub/other.md"],
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/sub/c.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        expect(batch.sort()).toEqual(["dir1/a.md", "dir1/sub/c.md"]);
        // `dir2` shares nothing but the parent: it is never enumerated, never
        // queried, and never reconciled. (`dir1` itself is asked about on both
        // seams - the direct-children answer is prefetched with the flush,
        // before the disk reports the directory gone.)
        expect(descendantCalls).toEqual(["dir1"]);
        expect(directCalls).not.toContain("dir2");
        expect(descendantCalls).not.toContain("dir2");
        expect(harness.started.map((event) => event.directory)).not.toContain(
          "dir2"
        );
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "a prefix-sharing sibling directory is not swept in by the subtree query",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-subtree-prefix-"));
      await mkdir(join(root, "dir10"), { recursive: true });
      await Bun.write(join(root, "dir10", "x.md"), "# x\n");

      // The store double answers exactly what the real indexed query answers:
      // `dir1`'s subtree, never `dir10`'s. The watcher must ask for `dir1` and
      // nothing broader - the SQL-level prefix guard is pinned separately in
      // `test/store/active-descendants.test.ts`.
      const { store, descendantCalls } = createSubtreeStore({
        descendants: { dir1: ["dir1/a.md"], dir10: ["dir10/x.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/a.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches[0]).toEqual(["dir1/a.md"]);
        expect(descendantCalls).toEqual(["dir1"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 corrective coverage — a DIRECTORY whose name matches the collection
 * pattern.
 *
 * `archive.md` is a legal directory name and `**\/*.md` matches it exactly as
 * it matches a document, so an event naming the bare `archive.md` takes the
 * ELIGIBLE exact-path route. Once it has vanished neither `matchesWalkPath`
 * (filesystem-free by design) nor the disk (the path is gone) can say which it
 * was. Collapsing it to its surviving parent on the strength of the NAME left
 * every document under `archive.md/` active and searchable indefinitely — the
 * same silent-staleness class this reconciliation work exists to remove,
 * reached through a name that merely looks like a file.
 *
 * The decision therefore belongs to the INDEXED side, on the same batched
 * descendant seam the ineligible-event route already uses: active indexed
 * descendants mean a removed directory subtree, none means an ordinary
 * vanished file that collapses to its parent. These tests pin both directions
 * plus the round-trip budget, because a per-hint query would be a real
 * regression even with a correct answer.
 */
describe("CollectionWatchService file-like directory names", () => {
  test(
    "deactivates the whole subtree of a deleted directory named like a document",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-dirname-md-"));
      // Post-delete disk state: `archive.md/` and everything under it is gone;
      // the untouched root document survives.
      await Bun.write(join(root, "keep.md"), "# keep\n");

      const { store, descendantCalls, descendantRoundTrips } =
        createSubtreeStore({
          descendants: {
            "archive.md": ["archive.md/child.md", "archive.md/sub/deep.md"],
          },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // The bare directory name is ELIGIBLE, so this is the exact-path route,
        // not the ambiguous-event route.
        harness.emit([["rename", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The documents the event never named. Before the fix they stayed
        // active forever: the parent's direct-child query cannot see beneath
        // `archive.md/`, so nothing ever implicated them.
        expect(batch).toContain("archive.md/child.md");
        // Any depth, not just direct children.
        expect(batch).toContain("archive.md/sub/deep.md");
        // Bounded: the surviving root document is not dragged in.
        expect(batch).not.toContain("keep.md");
        // The removed directory IS the reconciled area, so the root is neither
        // enumerated nor reconciled.
        expect(harness.started).toEqual([
          { collection: "notes", directory: "archive.md" },
        ]);
        expect(descendantCalls).toEqual(["archive.md"]);
        expect(descendantRoundTrips).toHaveLength(1);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "collapses a vanished file-like name with no indexed descendants to its parent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-dirname-file-"));
      await Bun.write(join(root, "keep.md"), "# keep\n");

      // Same event shape as the test above, opposite indexed answer:
      // `archive.md` was an ordinary root-level document. The discriminator
      // must not over-widen it into a subtree removal.
      const { store, descendantCalls, directCalls } = createSubtreeStore({
        direct: { "": ["archive.md", "keep.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The deleted file still reaches `syncPaths`, which marks it inactive.
        expect(batch).toContain("archive.md");
        expect(batch).toContain("keep.md");
        // Collapsed to the surviving parent - here the collection root - and
        // reconciled as an ordinary vanished file. `archive.md` is never
        // treated as a directory: it is not enumerated and never started.
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        // Asked once, on the discriminator seam, and answered "nothing here".
        expect(descendantCalls).toEqual(["archive.md"]);
        expect(directCalls).toEqual(["", "archive.md"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reconciles exactly the surviving directory of an ordinary vanished file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-dirname-narrow-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await mkdir(join(root, "dir2"), { recursive: true });
      // `dir1/note.md` was deleted; its directory and neighbour survive.
      await Bun.write(join(root, "dir1", "neighbour.md"), "# neighbour\n");
      await Bun.write(join(root, "dir2", "other.md"), "# other\n");

      const { store, descendantCalls, directCalls } = createSubtreeStore({
        direct: { dir1: ["dir1/note.md", "dir1/neighbour.md"] },
        descendants: { dir1: ["dir1/note.md", "dir1/neighbour.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/note.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        expect(batch).toContain("dir1/note.md");
        expect(batch).toContain("dir1/neighbour.md");
        // Not widened: the untouched sibling directory stays out of the batch,
        // is never enumerated, and is never queried on either seam.
        expect(batch).not.toContain("dir2/other.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "dir1" },
        ]);
        // The vanished path is discriminated; its SURVIVING parent is not asked
        // about on the subtree seam, because nothing observed it missing.
        expect(descendantCalls).toEqual(["dir1/note.md"]);
        expect(directCalls).toEqual(["dir1", "dir1/note.md"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "discriminates a whole window of vanished paths in one round trip per seam",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-dirname-budget-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await Bun.write(join(root, "dir1", "neighbour.md"), "# neighbour\n");

      const { store, directRoundTrips, descendantRoundTrips } =
        createSubtreeStore({
          direct: { dir1: ["dir1/neighbour.md"] },
          descendants: {
            "archive.md": ["archive.md/child.md"],
          },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Five vanished eligible paths in one debounce window: four ordinary
        // files in a surviving directory plus one directory named like a
        // document. Every one of them needs the discriminator.
        harness.emit([
          ["rename", "dir1/a.md"],
          ["rename", "dir1/b.md"],
          ["rename", "dir1/c.md"],
          ["rename", "dir1/d.md"],
          ["rename", "archive.md"],
        ]);
        expect(await harness.settle()).toBe("settled");

        // The budget is the point: key count tracks event count, round trips do
        // not. A per-hint query here would be a coalescing regression even
        // though every answer would be correct.
        expect(descendantRoundTrips).toHaveLength(1);
        expect(descendantRoundTrips[0]?.slice().sort()).toEqual([
          "archive.md",
          "dir1/a.md",
          "dir1/b.md",
          "dir1/c.md",
          "dir1/d.md",
        ]);
        expect(directRoundTrips).toHaveLength(1);
        // Still correct, not just cheap.
        const batch = harness.batches[0] ?? [];
        expect(batch).toContain("archive.md/child.md");
        expect(batch).toContain("dir1/neighbour.md");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 corrective coverage — the REPLACEMENT direction of the same question.
 *
 * The suite above covers an indexed directory that VANISHED under an
 * eligible-looking name. The mirror case is an indexed directory deleted and
 * replaced by a regular FILE of that same name inside one debounce window
 * (`archive.md/` holding `archive.md/child.md`, then a document `archive.md`).
 *
 * The disk answers "still here", because it is — as a file. The exact-path
 * flow then synced only `archive.md`, never ran the indexed-descendant
 * discriminator, and left every document under the old directory active and
 * searchable indefinitely, while a full `gno update` deactivated them. A
 * directory replaced by a SYMLINK was already covered (the walker cannot reach
 * through it, so it classifies as gone); a plain file was not.
 *
 * The fix is the shape the design already uses: a visible NON-DIRECTORY leaf
 * is a REPLACEMENT CANDIDATE, discriminated on the indexed side through the
 * flush's single batched descendant lookup. It differs from a hint in the one
 * way that matters for cost — a candidate that resolves to nothing resolves to
 * NOTHING, with no directory fallback — because every ordinary file event is
 * one of these, and a fallback would enumerate the parent of every live edit.
 */
describe("CollectionWatchService directory replaced by a file", () => {
  test(
    "deactivates the subtree of a directory rewritten as a document",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-replace-file-"));
      // Post-replacement disk state: `archive.md` is now a regular FILE.
      await Bun.write(join(root, "archive.md"), "# archive\n");
      await Bun.write(join(root, "keep.md"), "# keep\n");

      const { store, descendantCalls, directCalls, descendantRoundTrips } =
        createSubtreeStore({
          descendants: { "archive.md": ["archive.md/child.md"] },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // One eligible name, present on disk: the delete of the directory and
        // the write of the file coalesce into a single reported path.
        harness.emit([["rename", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The document the event never named. Before the fix it stayed active
        // forever: the path exists, so nothing ever implicated it.
        expect(batch).toContain("archive.md/child.md");
        // ...and the new file is still indexed. Widening must not cost the
        // exact path its own place in the batch.
        expect(batch).toContain("archive.md");
        // Bounded: the untouched root document is not dragged in, and the root
        // is neither enumerated nor reconciled.
        expect(batch).not.toContain("keep.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "archive.md" },
        ]);
        // One question, on the discriminator seam, in one round trip - and no
        // direct-children query at all, because a surviving file has no
        // direct-children question to answer.
        expect(descendantCalls).toEqual(["archive.md"]);
        expect(descendantRoundTrips).toHaveLength(1);
        expect(directCalls).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reaches a descendant nested below the replaced directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-replace-deep-"));
      await Bun.write(join(root, "archive.md"), "# archive\n");

      // Every indexed document sits one level DEEPER than the replaced name,
      // so a direct-children answer would see nothing at all.
      const { store, descendantCalls } = createSubtreeStore({
        direct: { "archive.md": [] },
        descendants: { "archive.md": ["archive.md/sub/deep.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        expect(batch).toContain("archive.md/sub/deep.md");
        expect(batch).toContain("archive.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "archive.md" },
        ]);
        expect(descendantCalls).toEqual(["archive.md"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "an ordinary new file costs no round trip beyond the shared probe",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-replace-plain-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await Bun.write(join(root, "dir1", "new.md"), "# new\n");
      await Bun.write(join(root, "dir1", "neighbour.md"), "# neighbour\n");

      // Nothing is indexed beneath the new name - it merely shares the shape.
      const { store, directCalls, directRoundTrips, descendantRoundTrips } =
        createSubtreeStore({
          direct: { dir1: ["dir1/neighbour.md"] },
          descendants: { dir1: ["dir1/neighbour.md"] },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/new.md"]]);
        expect(await harness.settle()).toBe("settled");

        // The exact path alone was the whole change.
        expect(harness.batches).toEqual([["dir1/new.md"]]);
        // The probe rides ONE batched round trip and asks nothing else: no
        // direct-children query, no enumeration, no reconciliation, and no
        // per-path lookup that would grow with the event count.
        expect(descendantRoundTrips).toHaveLength(1);
        expect(directRoundTrips).toEqual([]);
        expect(directCalls).toEqual([]);
        expect(harness.started).toEqual([]);
        expect(harness.ambiguous).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 corrective coverage — the three conditions the subtree work left open.
 *
 * 1. The collection ROOT is the ceiling of the ancestor walk, and that ceiling
 *    used to double as a claim that the root still exists. It does not: a
 *    deleted collection directory left every document beneath it active.
 * 2. The removal CLASSIFICATION is made by one `stat` and consumed by a later
 *    enumeration. Between the two, a directory can be recreated. The intent is
 *    now carried on the queue instead of re-derived, so the recreation cannot
 *    silently narrow a subtree removal to direct children.
 * 3. A failed descendant query is not an empty subtree. Conflating them let a
 *    store outage downgrade a deleted subtree to a parent reconciliation with
 *    no diagnostic at all.
 */
describe("CollectionWatchService removed-root and recreation reconciliation", () => {
  test(
    "deactivates every document beneath a REMOVED collection root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-root-gone-"));
      // The collection directory itself is gone - unmounted, moved, or `rm
      // -rf`d. Nothing under it can be enumerated, so the indexed side is the
      // only side there is.
      await rm(root, { recursive: true, force: true });

      const { store, allCalls, descendantCalls } = createSubtreeStore({
        all: ["top.md", "dir1/a.md", "dir1/sub/deep.md"],
        descendants: { dir1: ["dir1/a.md", "dir1/sub/deep.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Bun names one arbitrary child; the root above it is gone too.
        harness.emit([["rename", "dir1/a.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // At ANY depth: the root-level file, the named child, and the document
        // two levels down all reach `syncPaths`, which marks each missing path
        // inactive. Before the fix the walk stopped at the root, reconciled
        // `dir1` alone, and `top.md` stayed retrievable forever.
        expect(batch).toContain("top.md");
        expect(batch).toContain("dir1/a.md");
        expect(batch).toContain("dir1/sub/deep.md");
        // A removed root has no bounded subtree, so the whole-collection seam
        // answers it - exactly once, and only for this condition.
        expect(allCalls).toEqual(["notes"]);
        expect(descendantCalls).toEqual([]);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test.skipIf(process.getuid?.() === 0)(
    "infers no removal when the collection root cannot be STATTED",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "gno-watch-root-eacces-"));
      const root = join(base, "collection");
      await mkdir(join(root, "dir1"), { recursive: true });
      await Bun.write(join(root, "dir1", "a.md"), "# a\n");
      // Unreadable, NOT absent. `stat` fails with EACCES, and a failure is not
      // evidence that anything went anywhere.
      await chmod(base, 0o000);

      const { store, allCalls, descendantCalls, directCalls } =
        createSubtreeStore({
          all: ["dir1/a.md", "dir1/b.md", "top.md"],
          descendants: { dir1: ["dir1/a.md", "dir1/b.md"] },
        });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/a.md"]]);
        expect(await harness.settle()).toBe("settled");

        // The reported path still rides the ordinary per-path flow (`syncPaths`
        // decides what an unreadable file means), but NOTHING widened: no
        // subtree, no whole-collection sweep, no reconciliation at all.
        expect(harness.batches).toEqual([["dir1/a.md"]]);
        expect(allCalls).toEqual([]);
        expect(descendantCalls).toEqual([]);
        expect(directCalls).toEqual([]);
        expect(harness.started).toEqual([]);
      } finally {
        await chmod(base, 0o700).catch(() => undefined);
        await harness.service.dispose();
        await rm(base, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "treats a path deleted and RECREATED before the flush as a live edit (documented limit)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-recreate-path-"));
      await mkdir(join(root, "dir1"), { recursive: true });
      await Bun.write(join(root, "dir1", "a.md"), "# a\n");
      await Bun.write(join(root, "dir1", "b.md"), "# b\n");

      const { store, descendantCalls, directCalls } = createSubtreeStore({
        direct: { dir1: ["dir1/a.md", "dir1/b.md"] },
        descendants: { dir1: ["dir1/a.md", "dir1/b.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // `dir1/` is deleted with both files in it...
        await rm(join(root, "dir1"), { recursive: true, force: true });
        harness.emit([["rename", "dir1/a.md"]]);
        // ...and recreated - with only `a.md` - inside the same 300 ms debounce
        // window, BEFORE the flush stats the reported path.
        await mkdir(join(root, "dir1"), { recursive: true });
        await Bun.write(join(root, "dir1", "a.md"), "# a again\n");
        expect(await harness.settle()).toBe("settled");

        // THE GUARANTEE, asserted rather than implied: the widening decision is
        // one `stat` at flush time, and Bun coalesces events inside a watcher
        // read batch, so a delete immediately followed by a recreate is
        // indistinguishable from an edit by the time the watcher can look. The
        // reported path is synced as an edit and nothing widens - `dir1/b.md`,
        // which really did go, stays active until another event names its area
        // or `gno update` runs. This window cannot be closed from inside the
        // watcher; it is documented in docs/TROUBLESHOOTING.md and R1.
        expect(harness.batches).toEqual([["dir1/a.md"]]);
        expect(directCalls).toEqual([]);
        expect(harness.started).toEqual([]);
        // The recreated path rides the batched replacement probe like any
        // other surviving file. It answers "nothing indexed beneath
        // `dir1/a.md`", so the documented limit above is unchanged: the probe
        // asks about the SUBTREE OF the reported name, which is not the
        // question this window loses (`dir1/b.md` is a sibling, not a
        // descendant).
        expect(descendantCalls).toEqual(["dir1/a.md"]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps the subtree intent when the removed ancestor is RECREATED before enumeration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-recreate-anc-"));
      await Bun.write(join(root, "keep.md"), "# keep\n");
      // `dir1/` and everything in it is gone at classification time.

      const { store, descendantCalls } = createSubtreeStore({
        direct: { dir1: ["dir1/a.md"] },
        descendants: { dir1: ["dir1/a.md", "dir1/sub/deep.md"] },
        // Runs after the ancestor walk observed `dir1` missing and before the
        // directory is enumerated: the exact race a second filesystem
        // observation would lose.
        duringLookup: async () => {
          await mkdir(join(root, "dir1"), { recursive: true });
          await Bun.write(join(root, "dir1", "a.md"), "# restored\n");
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/a.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The enumeration now finds `dir1` present again. Re-deriving the
        // classification from it would narrow the reconciliation to the
        // directory's DIRECT children and strand `dir1/sub/deep.md`, which is
        // still gone. The intent recorded at classification time is what keeps
        // the subtree answer.
        expect(batch).toContain("dir1/sub/deep.md");
        expect(batch).toContain("dir1/a.md");
        expect(batch).not.toContain("keep.md");
        expect(descendantCalls).toContain("dir1");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reports a failed DESCENDANT query instead of reading it as an empty subtree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-hint-store-fail-"));
      // The atomic-save sibling that the parent-directory fallback must still
      // pick up even while the store is refusing to answer.
      await Bun.write(join(root, "note.md"), "# atomic\n");

      const { store } = createSubtreeStore({
        descendants: { dir1: ["dir1/a.md"] },
        descendantsFail: true,
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // The Bun 1.3.11 recursive-delete shape: only the bare directory.
        harness.emit([["rename", "dir1"]]);
        expect(await harness.settle()).toBe("settled");

        // The store failure is VISIBLE and attributed to the hint it blocked.
        // Previously `ok: false` was folded into "no descendants", so the
        // deleted subtree silently degraded to a parent reconciliation with no
        // diagnostic at all (R7/R9).
        expect(
          harness.failed.filter((event) => event.stage === "store")
        ).toEqual([
          expect.objectContaining({
            collection: "notes",
            directory: "dir1",
            stage: "store",
          }),
        ]);
        // Nothing is inferred from the unanswered query: `dir1/a.md` is not
        // deactivated, and the hint directory is never reconciled at all.
        const batch = harness.batches[0] ?? [];
        expect(batch).not.toContain("dir1/a.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
        // Parent disk reconciliation still runs, so an atomic save landing in
        // the same window is not lost to the outage.
        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 corrective coverage — the CALLBACK-COUNT half of the same
 * amplification the cause STRINGS were already bounded against (R7/R9).
 *
 * The replacement discriminator asks its question in ONE batched round trip, so
 * a failed lookup stores the SAME error against every key. Expanding that one
 * failure into one `onReconcileFailed` per candidate meant a checkout or
 * sync-client burst during a store outage produced thousands of identical
 * diagnostics from a single failure — piling load and log volume onto a store
 * that is already in trouble. Every visible file event is a replacement
 * candidate, so the burst size is the event count, not some rare shape.
 */
describe("CollectionWatchService batched replacement failure is reported once", () => {
  test(
    "emits ONE bounded aggregate diagnostic for a burst of blocked candidates",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-repl-burst-"));
      // A checkout-sized burst: every one of these exists on disk, so every one
      // is a replacement candidate riding the single batched descendant lookup.
      const burst = Array.from({ length: 12 }, (_, index) => `f${index}.md`);
      for (const relPath of burst) {
        await Bun.write(join(root, relPath), `# ${relPath}\n`);
      }

      const { store } = createSubtreeStore({
        // Indexed beneath one of the candidates: if the outage were ever read
        // as "nothing is indexed here", this is what would deactivate.
        descendants: { "f0.md": ["f0.md/child.md"] },
        descendantsFail: true,
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit(burst.map((relPath) => ["change", relPath] as const));
        expect(await harness.settle()).toBe("settled");

        // THE ASSERTION THAT MATTERS: the COUNT, not the wording. Before the
        // fix this was 12 - one per candidate - from one failed round trip.
        const storeFailures = harness.failed.filter(
          (event) => event.stage === "store"
        );
        expect(storeFailures).toHaveLength(1);
        expect(storeFailures[0]).toMatchObject({
          collection: "notes",
          // The batch failed as a whole, so there is no honest per-key
          // attribution left to publish.
          directory: null,
          stage: "store",
        });

        // Bounded aggregate: exact total, at most three names, explicit
        // remainder - and the store's own error preserved underneath.
        const cause = storeFailures[0]?.cause as Error;
        expect(cause.message).toContain("12 replacement candidate(s)");
        expect(cause.message).toContain("(+9 more)");
        expect(cause.message).toContain("f0.md");
        expect(cause.message).not.toContain("f11.md");
        expect(cause.cause).toMatchObject({ code: "QUERY_FAILED" });

        // Fail-closed is UNCHANGED: an unanswered lookup still infers nothing
        // and deactivates nothing, and the exact paths sync exactly as before.
        const batch = harness.batches[0] ?? [];
        expect(batch.slice().sort()).toEqual(burst.slice().sort());
        expect(batch).not.toContain("f0.md/child.md");
        expect(harness.started).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "still names the blocked candidate when only ONE was blocked",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-repl-single-"));
      await Bun.write(join(root, "archive.md"), "# archive\n");

      const { store } = createSubtreeStore({
        descendants: { "archive.md": ["archive.md/child.md"] },
        descendantsFail: true,
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["change", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        // Aggregating must not cost the ordinary single-failure case its
        // attribution: one blocked candidate is still reported against the
        // directory it blocked, carrying the store's own error unwrapped.
        expect(
          harness.failed.filter((event) => event.stage === "store")
        ).toEqual([
          {
            collection: "notes",
            directory: "archive.md",
            stage: "store",
            cause: { code: "QUERY_FAILED", message: "store offline" },
          },
        ]);
        // Fail-closed, as ever: nothing under the blocked candidate is touched.
        expect(harness.batches).toEqual([["archive.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * A `syncPaths` call that RESOLVES is not the same as one whose paths all
 * succeeded: ordinary per-file failures (EACCES, a converter error, a failed
 * `markInactive`) come back inside the result, not as a rejection. Reporting
 * completion off "the promise resolved" made a directory whose documents are
 * now stale read identically in the daemon log to one that reconciled cleanly.
 */
describe("CollectionWatchService sync-stage failure attribution (R7)", () => {
  test(
    "reports a sync-stage failure for a directory whose contributed path errored",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-syncerr-"));
      const { store } = createRecordingStore({ dir1: ["dir1/a.md"] });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        syncResult: (relPaths) =>
          createSyncResult({
            filesProcessed: relPaths.length,
            filesErrored: relPaths.length,
            files: relPaths.map((relPath) => ({
              relPath,
              status: "error",
              errorCode: "EACCES",
              errorMessage: "permission denied",
            })),
          }),
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches[0]).toContain("dir1/a.md");
        // The directory owes exactly one terminal outcome, and with its only
        // contributed path errored that outcome is a FAILURE, not a completion.
        expect(
          harness.failed.filter((event) => event.directory === "dir1")
        ).toHaveLength(1);
        expect(harness.failed[0]).toMatchObject({
          collection: "notes",
          directory: "dir1",
          stage: "sync",
        });
        expect(
          String((harness.failed[0]?.cause as Error | undefined)?.message)
        ).toContain("dir1/a.md");
        // Never both.
        expect(
          harness.completed.filter((event) => event.directory === "dir1")
        ).toHaveLength(0);
        // ...and every started directory still reached exactly one outcome.
        for (const start of harness.started) {
          const outcomes =
            harness.completed.filter(
              (event) => event.directory === start.directory
            ).length +
            harness.failed.filter(
              (event) => event.directory === start.directory
            ).length;
          expect(outcomes).toBe(1);
        }
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "attributes sync errors per directory in a mixed batch",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-syncmixed-"));
      const { store } = createRecordingStore({
        dir1: ["dir1/a.md"],
        dir2: ["dir2/b.md"],
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        // Only `dir1`'s path fails. `dir2` shares the same `syncPaths` call,
        // but one directory's EACCES says nothing about another's paths, so
        // `dir2` must still complete normally.
        syncResult: (relPaths) =>
          createSyncResult({
            filesProcessed: relPaths.length,
            filesErrored: relPaths.filter((relPath) =>
              relPath.startsWith("dir1/")
            ).length,
            filesUpdated: relPaths.filter(
              (relPath) => !relPath.startsWith("dir1/")
            ).length,
            files: relPaths.map((relPath) =>
              relPath.startsWith("dir1/")
                ? {
                    relPath,
                    status: "error" as const,
                    errorCode: "CONVERT_FAILED",
                    errorMessage: "converter blew up",
                  }
                : { relPath, status: "updated" as const }
            ),
          }),
      });

      try {
        harness.service.start();
        harness.emit([
          ["rename", "dir1"],
          ["rename", "dir2"],
        ]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches[0]).toContain("dir1/a.md");
        expect(harness.batches[0]).toContain("dir2/b.md");
        expect(harness.failed.map((event) => event.directory)).toEqual([
          "dir1",
        ]);
        expect(
          harness.completed.filter((event) => event.directory === "dir2")
        ).toEqual([
          {
            collection: "notes",
            directory: "dir2",
            candidateCount: 1,
            syncedCount: 1,
          },
        ]);
        expect(
          harness.completed.filter((event) => event.directory === "dir1")
        ).toHaveLength(0);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "still completes every directory when the sync reports no errors",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-syncok-"));
      const { store } = createRecordingStore({
        dir1: ["dir1/a.md"],
        dir2: ["dir2/b.md"],
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([
          ["rename", "dir1"],
          ["rename", "dir2"],
        ]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.failed).toEqual([]);
        expect(
          harness.completed.filter((event) => event.directory === "dir1")
        ).toEqual([
          {
            collection: "notes",
            directory: "dir1",
            candidateCount: 1,
            syncedCount: 1,
          },
        ]);
        expect(
          harness.completed.filter((event) => event.directory === "dir2")
        ).toEqual([
          {
            collection: "notes",
            directory: "dir2",
            candidateCount: 1,
            syncedCount: 1,
          },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * fn-114 corrective coverage - suppression must not swallow deletions, and an
 * accepted ambiguous event must be visible in `lastEventAt`.
 *
 * Both defects shared a shape: an event that the watcher had genuinely
 * observed was thrown away at the callback, before anything that could tell
 * what it MEANT had run.
 *
 * - Suppression exists so GNO's own writes do not feed back into the watcher.
 *   Applied as a blanket callback-side drop it also discarded the evidence of
 *   an unrelated DELETION - and on Bun 1.3.14 a recursive directory delete
 *   reports one arbitrary child, so if that child happened to be suppressed,
 *   the whole subtree stayed active and searchable indefinitely.
 * - `lastEventAt` was written only on the exact-path branch, so the PRIMARY
 *   scenario this work exists for - an atomic save reported only under its
 *   ineligible temp name - reconciled correctly while `GET /api/status` still
 *   claimed the watcher had seen nothing.
 *
 * The two cases `lastEventAt` must keep apart are pinned together below: an
 * event DROPPED (excluded, or ineligible with nothing reconcilable) still
 * contributes no timestamp, while an event ACCEPTED for reconciliation that
 * produces real work does.
 */
describe("CollectionWatchService suppression and observed-event visibility", () => {
  test(
    "classifies a suppressed path that vanished instead of discarding it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-gone-"));
      // `archive.md/` and everything under it is already gone from disk; the
      // untouched root document survives.
      await Bun.write(join(root, "keep.md"), "# keep\n");
      const { store, descendantCalls } = createSubtreeStore({
        descendants: {
          "archive.md": ["archive.md/child.md", "archive.md/sub/deep.md"],
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // GNO wrote this path itself, so it is inside its suppression window -
        // and then it was deleted out from under us.
        harness.service.suppress(join(root, "archive.md"));
        harness.emit([["rename", "archive.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // Before the fix the event never reached classification at all: no
        // store lookup, no reconciliation, and both documents stayed active.
        expect(batch).toContain("archive.md/child.md");
        expect(batch).toContain("archive.md/sub/deep.md");
        expect(batch).not.toContain("keep.md");
        expect(harness.started).toEqual([
          { collection: "notes", directory: "archive.md" },
        ]);
        expect(descendantCalls).toEqual(["archive.md"]);
        // A deletion is a real observed change, whoever wrote the path last.
        expect(harness.service.getState().lastEventAt).not.toBeNull();
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "deactivates a suppressed indexed child of a recursively removed directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-child-"));
      // `dir1/` was removed recursively and Bun reported the bare directory,
      // so the suppressed child is never NAMED by any event - it only appears
      // as a RESOLVED reconciliation candidate from the indexed side. That is
      // the second suppression filter, and it used to drop the candidate
      // unconditionally: `a.md` stayed active and searchable until a full
      // `gno update`, because the parent fallback cannot see nested
      // descendants either.
      await Bun.write(join(root, "keep.md"), "# keep\n");
      const { store } = createSubtreeStore({
        descendants: { dir1: ["dir1/a.md", "dir1/b.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // GNO wrote `dir1/a.md` through the capture/API path, so it is inside
        // its suppression window - and then its whole directory was deleted.
        harness.service.suppress(join(root, "dir1", "a.md"));
        harness.emit([["rename", "dir1"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        expect(batch).toContain("dir1/a.md");
        // The unsuppressed sibling was never in doubt; it pins that the
        // suppressed one is the only thing this test changed.
        expect(batch).toContain("dir1/b.md");
        expect(batch).not.toContain("keep.md");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps filtering a suppressed candidate that still exists on disk",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-mixed-"));
      // Both are suppressed application writes; only one still exists. The
      // rule is the same one the callback route follows - suppression
      // suppresses SYNCING a write that is still there, never CLASSIFICATION
      // of one that has vanished - so exactly one of them may be synced.
      await Bun.write(join(root, "alive.md"), "# written by gno\n");
      const { store } = createSubtreeStore({
        direct: { "": ["alive.md", "gone.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "alive.md"));
        harness.service.suppress(join(root, "gone.md"));
        // An ineligible temp name, so the whole directory reconciles and both
        // candidates arrive resolved rather than named.
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["gone.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "fails closed when a suppressed candidate cannot be statted",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-eio-"));
      // `gone.md` is not on disk, but the disk cannot SAY so: an unreadable
      // path (EACCES, EIO, a hung mount) is not evidence of absence, so the
      // suppression stands and nothing is deactivated on the strength of it.
      const { store } = createSubtreeStore({ direct: { "": ["gone.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => ({
          status: "error",
          cause: new Error("EIO: unreadable"),
        }),
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "gone.md"));
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "still refuses to resync a suppressed path that is still on disk",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-alive-"));
      // The file EXISTS: this is an ordinary application write feeding back,
      // which is the case suppression was built for and must keep handling.
      await Bun.write(join(root, "note.md"), "# written by gno\n");
      const { store } = createSubtreeStore({ direct: { "": ["note.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "note.md"));
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([]);
        // Nor does an application's own write count as an observed change.
        expect(harness.service.getState().lastEventAt).toBeNull();
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "advances lastEventAt for an accepted ambiguous event but not a dropped one",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-last-event-"));
      await Bun.write(join(root, "note.md"), "# atomic save landed\n");
      const { store } = createSubtreeStore({ direct: { "": ["note.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Dropped: a dot-prefixed area is never walked, so nothing is queued
        // and nothing was meaningfully observed.
        harness.emit([["change", ".obsidian/.sync.lock"]]);
        // The drop is SYNCHRONOUS - the watch callback refuses the area before
        // it queues anything - so the queue state is asserted immediately.
        // Waiting out a debounce window here would have proved the same thing
        // by wall clock, which is exactly what R8 forbids.
        expect(harness.service.getState().queuedCollections).toEqual([]);
        expect(harness.batches).toEqual([]);
        expect(harness.service.getState().lastEventAt).toBeNull();

        const before = new Date().toISOString();
        // Accepted: the atomic save is reported only under its temp name, is
        // reconciled to the real document, and is therefore a real observation.
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["note.md"]]);
        const { lastEventAt } = harness.service.getState();
        expect(lastEventAt).not.toBeNull();
        // The OBSERVATION time is published, not the flush time, so the
        // debounce window never shows up as latency in the reported state.
        expect(new Date(lastEventAt ?? 0).getTime()).toBeGreaterThanOrEqual(
          new Date(before).getTime()
        );
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * Advance past the current millisecond so two observations taken either side of
 * this call are strictly ordered.
 *
 * This is NOT a sleep standing in for synchronization (R8): it waits on an
 * observable signal - the clock reading actually changing - and returns the
 * instant it does. Nothing below is timed against a duration.
 */
async function nextObservableMs(): Promise<number> {
  const start = Date.now();
  while (Date.now() === start) {
    await Promise.resolve();
  }
  return Date.now();
}

/**
 * Suppression answers "was this GNO's own write?", which is a question about
 * the moment the event happened. Recognizing it when the callback runs and then
 * re-deciding it at flush time against a fresh clock is a different question,
 * and the flush is always later: a 300 ms debounce, a queued flush waiting on an
 * in-flight sync, and an awaited classification all sit in between.
 */
describe("CollectionWatchService suppression decided at event time", () => {
  test(
    "suppresses a surviving write whose window expires before the flush",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-expiry-"));
      await Bun.write(join(root, "note.md"), "# written by gno\n");
      const { store } = createSubtreeStore({ direct: { "": ["note.md"] } });

      let expireWindow: (() => void) | null = null;
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        // Classification is an awaited point INSIDE the flush, so expiring the
        // window here reaches exactly the state a slow stat, a long debounce,
        // or a queued flush would have produced - deterministically.
        resolveVanishedPath: async (): Promise<VanishedPathOutcome> => {
          expireWindow?.();
          return { status: "present", isDirectory: false };
        },
      });
      expireWindow = () => harness.service.suppress(join(root, "note.md"), 0);

      try {
        harness.service.start();
        harness.service.suppress(join(root, "note.md"), 5_000);
        // Suppressed AT EVENT TIME, and still on disk when the flush looks.
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        // Re-deciding suppression against the flush-time clock fed GNO's own
        // write straight back into `syncPaths`, which the receipt-time drop
        // this route replaced had always prevented.
        expect(harness.batches).toEqual([]);
        expect(harness.service.getState().lastEventAt).toBeNull();
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "suppresses a surviving write whose flush waited behind an in-flight sync",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-queued-"));
      await mkdir(join(root, "other"), { recursive: true });
      await Bun.write(join(root, "other", "real.md"), "# unrelated\n");
      await Bun.write(join(root, "note.md"), "# written by gno\n");
      const { store } = createSubtreeStore({});

      const syncStarted = Promise.withResolvers<void>();
      const heldSync = Promise.withResolvers<void>();
      let gated = false;

      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
        syncGate: async () => {
          if (gated) {
            return;
          }
          gated = true;
          syncStarted.resolve();
          await heldSync.promise;
        },
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "note.md"), 5_000);
        // An unrelated directory's flush claims the collection and stalls.
        harness.emit([["rename", "other/x.tmp"]]);
        await syncStarted.promise;

        // Queued behind that sync: this flush cannot even start until it
        // resolves, and the suppression window expires while it waits.
        harness.emit([["change", "note.md"]]);
        harness.service.suppress(join(root, "note.md"), 0);

        const settled = harness.settle();
        heldSync.resolve();
        expect(await settled).toBe("settled");

        // The application's own write never reaches `syncPaths`, however long
        // the flush was delayed.
        expect(harness.batches).toEqual([["other/real.md"]]);
      } finally {
        heldSync.resolve();
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * "Decided at event time" is only a real rule if the suppression state can
 * still be ANSWERED for that moment later on. A bare expiry cannot: it records
 * no start and no history, so a window opened AFTER an event still compared as
 * later than that event and swallowed it retroactively - permanently, since
 * the comparison never stops being true once the window has been superseded.
 *
 * Reconciliation candidates are exactly the population that cannot dodge this.
 * They are unknown until the directory is enumerated, so their suppression
 * question is necessarily asked after the event that produced them (R4).
 */
describe("CollectionWatchService suppression membership per observation", () => {
  test(
    "reconciles a candidate whose event predates a later suppression window",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-later-"));
      // A genuine external edit, reported only under its atomic temp name.
      await Bun.write(join(root, "note.md"), "# edited in an editor\n");

      let suppressAfterTheEvent: (() => void) | null = null;
      const { store } = createSubtreeStore({
        direct: { "": ["note.md"] },
        // Inside the flush, AFTER the event was observed and before the
        // candidates are filtered - the window in which GNO writes some other
        // file and opens a suppression window that this event predates.
        duringLookup: async () => {
          suppressAfterTheEvent?.();
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });
      suppressAfterTheEvent = () =>
        harness.service.suppress(join(root, "note.md"), 5_000);

      try {
        harness.service.start();
        harness.emit([["rename", "note.md.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        // Comparing the event against the CURRENT expiry classified this
        // external change as GNO's own write and dropped it silently.
        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "drops a candidate suppressed across every contributing observation",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-all-"));
      await Bun.write(join(root, "alive.md"), "# written by gno\n");
      const { store } = createSubtreeStore({ direct: { "": ["alive.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.service.suppress(join(root, "alive.md"), 5_000);
        // Two ambiguous events coalesce onto one dirty directory; BOTH were
        // observed inside the window, so nothing contradicts suppression.
        harness.emit([
          ["rename", "a.tmp"],
          ["rename", "b.tmp"],
        ]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps a candidate suppressed for only one of two coalesced observations",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-suppress-one-"));
      await Bun.write(join(root, "alive.md"), "# edited in an editor\n");
      const { store } = createSubtreeStore({ direct: { "": ["alive.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Observed BEFORE any window exists: the application's write cannot
        // account for this one, which is the same `a && b` rule an exact path
        // gets from the pending-entry merge.
        harness.emit([["rename", "a.tmp"]]);
        await nextObservableMs();
        harness.service.suppress(join(root, "alive.md"), 5_000);
        harness.emit([["rename", "b.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        // Coalescing to `max(observedAtMs)` discarded the earlier observation
        // and dropped a real external change.
        expect(harness.batches).toEqual([["alive.md"]]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * A merged pending entry must not describe one observation with another's
 * clock reading. `max(observedAtMs)` beside an independent `suppressed` flag
 * did exactly that: the path reached the batch on the strength of an
 * unsuppressed event at `t1`, and then published `t2` - the timestamp of a
 * suppressed event the callback had deliberately dropped (R7).
 */
describe("CollectionWatchService publishes the eligible observation", () => {
  test(
    "publishes the unsuppressed observation, not a later suppressed one",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-eligible-obs-"));
      await Bun.write(join(root, "note.md"), "# edited in an editor\n");
      const { store } = createSubtreeStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // ELIGIBLE: an external edit, outside any suppression window.
        harness.emit([["change", "note.md"]]);
        const afterExternalEdit = await nextObservableMs();
        // DROPPED: GNO's own follow-up write to the same path. It cannot make
        // the path ineligible - `t1` already did that - but its timestamp
        // belongs to an observation suppression refused.
        harness.service.suppress(join(root, "note.md"), 5_000);
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["note.md"]]);
        const { lastEventAt } = harness.service.getState();
        expect(lastEventAt).not.toBeNull();
        expect(new Date(lastEventAt ?? 0).getTime()).toBeLessThan(
          afterExternalEdit
        );
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * `lastEventAt` exists to separate an ACCEPTED observation from a DROPPED one
 * (R7). One timestamp per COLLECTION cannot do that: with two directories in
 * one debounce window, the later event overwrites the earlier, and the first
 * directory's real work then publishes the dropped event's timestamp.
 */
describe("CollectionWatchService attributes observations per contributing work", () => {
  test(
    "does not publish a dropped event's timestamp on another directory's work",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-event-attr-"));
      await mkdir(join(root, "dirA"), { recursive: true });
      await mkdir(join(root, "dirB"), { recursive: true });
      await Bun.write(join(root, "dirA", "real.md"), "# atomic save landed\n");
      const { store } = createSubtreeStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // ACCEPTED: an atomic save reported only under its temp name; the
        // sibling it implies is on disk and reaches the batch.
        harness.emit([["rename", "dirA/note.md.tmp"]]);
        const afterDirA = await nextObservableMs();
        // DROPPED: a temp file in an empty directory. It reconciles to nothing
        // on both the disk and indexed sides, so it is not a change at all.
        harness.emit([["rename", "dirB/scratch.tmp"]]);
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["dirA/real.md"]]);
        // Both directories really were reconciled - `dirB` produced nothing,
        // which is the point, not that it was skipped.
        expect(
          harness.completed.map((event) => event.directory).sort()
        ).toEqual(["dirA", "dirB"]);
        expect(
          harness.completed.find((event) => event.directory === "dirB")
            ?.candidateCount
        ).toBe(0);

        const { lastEventAt } = harness.service.getState();
        expect(lastEventAt).not.toBeNull();
        // The published observation belongs to `dirA`, whose reconciliation
        // contributed the batch - never to the later `dirB` event that was
        // dropped and merely happened to share the window.
        expect(new Date(lastEventAt ?? 0).getTime()).toBeLessThan(afterDirA);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * Per-directory sync attribution is only sound while every reported failure
 * BELONGS to a batched path. `syncPaths` also reports collection-level
 * failures - under synthetic relPaths naming no file, or against a backlink
 * document outside the batch - and those match no candidate at all, so treating
 * them as attributable let every directory claim a clean completion the sync
 * did not support (R7/R9).
 */
describe("CollectionWatchService fails closed on unattributable sync errors", () => {
  async function runWithSyncErrors(
    label: string,
    errors: Array<{ relPath: string; code: string; message: string }>
  ) {
    const root = await mkdtemp(join(tmpdir(), `gno-watch-${label}-`));
    await Bun.write(join(root, "note.md"), "# atomic\n");
    const { store } = createSubtreeStore({});
    const harness = createReconcileHarness(createCollection("notes", root), {
      store,
      syncResult: (relPaths) =>
        createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
          files: relPaths.map((relPath) => ({ relPath, status: "updated" })),
          errors,
        }),
    });

    try {
      harness.service.start();
      harness.emit([["rename", "note.md.tmp"]]);
      expect(await harness.settle()).toBe("settled");
      expect(harness.batches).toEqual([["note.md"]]);
      return {
        completed: [...harness.completed],
        failed: harness.failed.map((event) => ({
          directory: event.directory,
          stage: event.stage,
        })),
        causes: harness.failed.map((event) =>
          String((event.cause as Error | undefined)?.message)
        ),
      };
    } finally {
      await harness.service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  test(
    "reports a typed-edge backfill failure instead of a clean completion",
    async () => {
      const outcome = await runWithSyncErrors("backfill-fail", [
        {
          relPath: "(typed edge backfill)",
          code: "QUERY_FAILED",
          message: "backfillDocEdges failed",
        },
      ]);

      expect(outcome.completed).toEqual([]);
      expect(outcome.failed).toEqual([{ directory: "", stage: "sync" }]);
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "reports a projection failure against an out-of-batch backlink document",
    async () => {
      const outcome = await runWithSyncErrors("projection-fail", [
        {
          relPath: "elsewhere/backlink.md",
          code: "QUERY_FAILED",
          message: "listDocuments failed",
        },
      ]);

      expect(outcome.completed).toEqual([]);
      expect(outcome.failed).toEqual([{ directory: "", stage: "sync" }]);
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * The fail-closed OUTCOME above and the reported CAUSE are separate
   * obligations. Substituting the contributed paths for the failure asserts
   * that THOSE paths failed - which the result does not say, and which sends
   * whoever reads the daemon log to the wrong file (R7/R9).
   */
  test(
    "names the collection-level backfill error, not the contributed paths",
    async () => {
      const outcome = await runWithSyncErrors("backfill-cause", [
        {
          relPath: "(typed edge backfill)",
          code: "QUERY_FAILED",
          message: "backfillDocEdges failed",
        },
      ]);

      const cause = outcome.causes[0] ?? "";
      expect(cause).toContain("(typed edge backfill)");
      expect(cause).toContain("backfillDocEdges failed");
      expect(cause).toContain("attribution was impossible");
      // The contributed path is the one thing the result says nothing about.
      expect(cause).not.toContain("note.md");
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "names the out-of-batch backlink document as the unowned failure",
    async () => {
      const outcome = await runWithSyncErrors("projection-cause", [
        {
          relPath: "elsewhere/backlink.md",
          code: "QUERY_FAILED",
          message: "listDocuments failed",
        },
      ]);

      const cause = outcome.causes[0] ?? "";
      expect(cause).toContain("elsewhere/backlink.md");
      expect(cause).toContain("listDocuments failed");
      expect(cause).not.toContain("note.md");
    },
    RED_TEST_TIMEOUT_MS
  );
});

describe("CollectionWatchService recreated-subtree enumeration", () => {
  test(
    "enumerates a RECREATED removed subtree recursively so nested new files index",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-recreate-deep-"));
      await Bun.write(join(root, "keep.md"), "# keep\n");
      // `dir1/` and everything in it is gone at classification time.

      const { store } = createSubtreeStore({
        direct: { dir1: ["dir1/a.md"] },
        descendants: { dir1: ["dir1/a.md"] },
        // Runs after the ancestor walk observed `dir1` missing and before the
        // directory is enumerated: the directory is restored, and the restore
        // writes a file into a NESTED subdirectory.
        duringLookup: async () => {
          await mkdir(join(root, "dir1", "sub"), { recursive: true });
          await Bun.write(join(root, "dir1", "a.md"), "# restored\n");
          await Bun.write(join(root, "dir1", "sub", "new.md"), "# brand new\n");
        },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        harness.emit([["rename", "dir1/a.md"]]);
        expect(await harness.settle()).toBe("settled");

        const batch = harness.batches[0] ?? [];
        // The removal intent is carried forward, so the indexed side still
        // answers for the whole subtree - but the DISK side has to match it. A
        // direct-children read of the recreated `dir1` sees only `a.md`, so
        // `dir1/sub/new.md` was in neither half of the union and, on Linux,
        // no later event ever names it (bun#15939).
        expect(batch).toContain("dir1/sub/new.md");
        expect(batch).toContain("dir1/a.md");
        // Still bounded: rooted at the recreated directory, never widened to
        // the collection.
        expect(batch).not.toContain("keep.md");
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * A HINT is a reconciliation key in its own right, so the "suppressed at every
 * contributing observation" rule must be answered from the events that named
 * THAT hint.
 *
 * Unioning a queued entry's whole witness set onto every hint it carried made
 * an event naming sibling hint `b` count as evidence about candidates under
 * hint `a` - and one unsuppressed witness is all it takes to defeat the rule,
 * so GNO's own surviving write was fed straight back into `syncPaths` (R4).
 */
describe("CollectionWatchService scopes suppression witnesses per hint", () => {
  test(
    "drops a hint's suppressed candidate despite an unsuppressed sibling hint event",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-hint-witness-"));
      await mkdir(join(root, "a"), { recursive: true });
      await mkdir(join(root, "b"), { recursive: true });
      // GNO's own write. It still EXISTS, so the only thing that may keep it
      // out of the batch is the suppression rule.
      await Bun.write(join(root, "a", "doc.md"), "# written by gno\n");

      const { store } = createSubtreeStore({
        direct: { "": [], a: ["a/doc.md"], b: [] },
        // Non-empty descendants are what make `a` a real indexed directory
        // rather than a dead temp name, so `a` is reconciled as its own key.
        descendants: { a: ["a/doc.md"] },
      });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();

        // Observation 1 for hint `a`: inside a window.
        harness.service.suppress(join(root, "a", "doc.md"), 5_000);
        harness.emit([["rename", "a"]]);
        // Closed only once the clock has moved past that observation, so the
        // window it was taken inside still contains it (`atMs < endMs`).
        await nextObservableMs();
        harness.service.suppress(join(root, "a", "doc.md"), 0);
        await nextObservableMs();

        // Observation for hint `b` ONLY, outside any window for `a/doc.md`.
        // Nothing about it is evidence about anything under `a`.
        harness.emit([["rename", "b"]]);
        await nextObservableMs();

        // Observation 2 for hint `a`: inside a second window.
        harness.service.suppress(join(root, "a", "doc.md"), 5_000);
        harness.emit([["rename", "a"]]);

        expect(await harness.settle()).toBe("settled");

        // EVERY observation that asked for `a` was suppressed, so the
        // application's own surviving write must not be resynced. Sharing the
        // parent entry's witnesses put the unsuppressed `b` observation into
        // `a`'s set and let it through.
        expect(harness.batches).toEqual([]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * The witness set is CAPPED; the published observation is not. Deriving
 * `lastEventAt` from the capped set reported the moment of the last RETAINED
 * witness rather than the latest observation actually accepted (R7).
 */
describe("CollectionWatchService publishes past the observation cap", () => {
  test(
    "publishes the latest accepted observation, not the last capped witness",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-obs-cap-"));
      await Bun.write(join(root, "note.md"), "# atomic save landed\n");
      const { store } = createSubtreeStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // More observations against one directory key than the witness cap
        // retains, each in its own millisecond - so the retained witnesses are
        // distinguishable from the ones the cap drops. Every gap stays far
        // below the debounce, so this is ONE window.
        const overCap = 300;
        for (let index = 0; index < overCap; index++) {
          harness.emit([["rename", `burst-${index}.tmp`]]);
          await nextObservableMs();
        }
        // The last observation, later than every witness the cap could hold.
        const beforeFinalEmit = Date.now();
        harness.emit([["rename", "final.tmp"]]);

        expect(await harness.settle()).toBe("settled");
        expect(harness.batches).toEqual([["note.md"]]);

        const { lastEventAt } = harness.service.getState();
        expect(lastEventAt).not.toBeNull();
        expect(new Date(lastEventAt ?? 0).getTime()).toBeGreaterThanOrEqual(
          beforeFinalEmit
        );
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * The cause of an unattributable sync failure describes the RESULT, which every
 * contributing directory shares. Formatting it per directory scaled the work
 * with `directories x errors` for one constant string - and did so even with no
 * observer installed to read it, amplifying an already-bad downstream failure
 * (R7/R9).
 */
describe("CollectionWatchService bounds the unattributable cause summary", () => {
  /** One reconcilable directory per name, each contributing one document. */
  async function runBroadFailure(options: {
    directories: string[];
    errorCount: number;
    observeFailures: boolean;
  }) {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-broad-cause-"));
    const direct: Record<string, string[]> = { "": [] };
    for (const directory of options.directories) {
      await mkdir(join(root, directory), { recursive: true });
      await Bun.write(join(root, directory, "note.md"), "# atomic\n");
      direct[directory] = [`${directory}/note.md`];
    }
    // A broad projection/store failure: many errors, none owned by a batched
    // path, so attribution collapses for every contributing directory at once.
    const errors = Array.from({ length: options.errorCount }, (_, index) => ({
      relPath: `elsewhere/backlink-${index}.md`,
      code: "QUERY_FAILED",
      message: `listDocuments failed (${index})`,
    }));

    const harness = createReconcileHarness(createCollection("notes", root), {
      store: createSubtreeStore({ direct }).store,
      omitReconcileFailedObserver: !options.observeFailures,
      syncResult: (relPaths) =>
        createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
          files: relPaths.map((relPath) => ({ relPath, status: "updated" })),
          errors,
        }),
    });

    try {
      harness.service.start();
      harness.emit(
        options.directories.map(
          (directory) => ["rename", `${directory}/save.tmp`] as const
        )
      );
      expect(await harness.settle()).toBe("settled");
      return {
        completed: [...harness.completed],
        causes: harness.failed.map((event) =>
          String((event.cause as Error | undefined)?.message)
        ),
      };
    } finally {
      await harness.service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  test(
    "names a bounded sample of a broad failure and reuses it across directories",
    async () => {
      const directories = ["d0", "d1", "d2", "d3", "d4", "d5"];
      const outcome = await runBroadFailure({
        directories,
        errorCount: 200,
        observeFailures: true,
      });

      expect(outcome.completed).toEqual([]);
      expect(outcome.causes).toHaveLength(directories.length);

      // Bounded: a sample plus a truncated count, never all 200 errors.
      const summary =
        "200 collection-level failure(s) owned by no batched path";
      for (const cause of outcome.causes) {
        expect(cause).toContain(summary);
        expect(cause).toContain("elsewhere/backlink-0.md");
        expect(cause).toContain("(+197 more)");
        expect(cause).not.toContain("elsewhere/backlink-3.md");
      }

      // Every directory reports the SAME summary, which is what makes building
      // it once outside the per-directory loop the correct shape.
      const summaries = outcome.causes.map((cause) =>
        cause.slice(cause.indexOf(summary))
      );
      expect(new Set(summaries).size).toBe(1);
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "still fails closed for every directory with no failure observer installed",
    async () => {
      const outcome = await runBroadFailure({
        directories: ["d0", "d1", "d2"],
        errorCount: 50,
        observeFailures: false,
      });

      // Skipping the cause must skip only the DESCRIPTION. A directory whose
      // sync failed unattributably still owes no completion.
      expect(outcome.completed).toEqual([]);
      expect(outcome.causes).toEqual([]);
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * The unowned SAMPLE was bounded, but the CONTRIBUTED failed paths named beside
 * it in the same cause were not - so one unowned failure alongside thousands of
 * contributed ones still built a per-directory diagnostic that scaled with the
 * failure it was describing, which is the amplification the bound exists to
 * stop (R7/R9). Nor was any single named value bounded, so one pathological
 * error message carried an unbounded cause on its own.
 */
describe("CollectionWatchService bounds every value it names in a cause", () => {
  const CONTRIBUTED_COUNT = 2000;
  /**
   * The surviving slice of the huge message. Requires a long run so it cannot
   * match the stray `y` in the cause's own prose ("per-directory").
   */
  const HUGE_MESSAGE_RUN = /y{20,}/;
  /** Comfortably above a bounded cause, far below an unbounded one. */
  const BOUNDED_CAUSE_LIMIT = 2_000;

  async function runContributedFailure(
    unownedMessage: string,
    unownedRelPath = "elsewhere/backlinks.md"
  ) {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-bounded-cause-"));
    const relPaths = Array.from(
      { length: CONTRIBUTED_COUNT },
      (_, index) => `note-${index}.md`
    );
    await Promise.all(
      relPaths.map((relPath) => Bun.write(join(root, relPath), "# note\n"))
    );

    const harness = createReconcileHarness(createCollection("notes", root), {
      store: createSubtreeStore({ direct: { "": relPaths } }).store,
      // Every contributed path is reported failed AND one failure is owned by
      // no batched path, so the cause carries both halves at once.
      syncResult: (batchedPaths) =>
        createSyncResult({
          filesProcessed: batchedPaths.length,
          files: batchedPaths.map((relPath) => ({
            relPath,
            status: "skipped",
          })),
          errors: [
            ...batchedPaths.map((relPath) => ({
              relPath,
              code: "WRITE_FAILED",
              message: "disk full",
            })),
            {
              relPath: unownedRelPath,
              code: "QUERY_FAILED",
              message: unownedMessage,
            },
          ],
        }),
    });

    try {
      harness.service.start();
      harness.emit([["rename", "save.tmp"]]);
      expect(await harness.settle()).toBe("settled");
      return harness.failed.map((event) =>
        String((event.cause as Error | undefined)?.message)
      );
    } finally {
      await harness.service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  test(
    "bounds a cause built from thousands of contributed failures",
    async () => {
      const causes = await runContributedFailure("store offline");

      expect(causes).toHaveLength(1);
      const [cause] = causes as [string];
      // The COUNT stays exact - only the listing is sampled.
      expect(cause).toContain(
        `${CONTRIBUTED_COUNT} contributed path(s) also reported failed`
      );
      expect(cause).toContain("note-0.md");
      expect(cause).toContain(`(+${CONTRIBUTED_COUNT - 3} more)`);
      expect(cause).not.toContain(`note-${CONTRIBUTED_COUNT - 1}.md`);
      expect(cause.length).toBeLessThan(BOUNDED_CAUSE_LIMIT);
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "bounds the length of any single value it names",
    async () => {
      // One failure, one error message, nothing to sample away: without a
      // per-value ceiling the sample bound does nothing here.
      const causes = await runContributedFailure("x".repeat(50_000));

      expect(causes).toHaveLength(1);
      const [cause] = causes as [string];
      expect(cause).toContain("elsewhere/backlinks.md");
      expect(cause.length).toBeLessThan(BOUNDED_CAUSE_LIMIT);
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "truncates each named field before it is interpolated, not after",
    async () => {
      // Bounding only the FINAL string still materializes the whole untrusted
      // value first: `path: message` was composed at full size and sliced
      // afterwards, so a multi-megabyte store error built a multi-megabyte
      // intermediate during exactly the cascading failure it describes (R7/R9).
      const hugeMessage = "y".repeat(2_000_000);
      const longRelPath = `elsewhere/${"d/".repeat(150)}backlinks.md`;
      const causes = await runContributedFailure(hugeMessage, longRelPath);

      expect(causes).toHaveLength(1);
      const [cause] = causes as [string];

      // Each field kept its OWN budget. Composing first and slicing after would
      // have spent the single budget on the path and dropped the message
      // entirely; here the message survives at exactly its own ceiling.
      const messageRun = HUGE_MESSAGE_RUN.exec(cause)?.[0] ?? "";
      expect(messageRun.length).toBe(MAX_DESCRIBED_VALUE_LENGTH);
      // The path is bounded on its own raw value too, not by what follows it.
      expect(cause).toContain(
        `${longRelPath.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...`
      );
      expect(cause).not.toContain(longRelPath);
      expect(cause.length).toBeLessThan(BOUNDED_CAUSE_LIMIT);
    },
    RED_TEST_TIMEOUT_MS
  );

  /**
   * The reconciled DIRECTORY is an untrusted path field like the others, and
   * both cause branches name it. Bounding only the failed paths left it
   * interpolated whole, so a legitimately deep directory - or a pathological
   * watcher-supplied name - rebuilt the unbounded intermediate the per-field
   * bound exists to remove, on the one field still missing it (R7/R9).
   *
   * The earlier coverage used the collection ROOT as the reconciliation
   * directory, so it only ever exercised the unowned failure's `relPath` and
   * `message` and never reached this field at all.
   */
  async function runDeepDirectoryFailure(attributable: boolean) {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-deep-dir-"));
    // Comfortably past the per-field budget while every segment stays a legal
    // filename, so this is a directory a real collection could hold.
    const deepDirectory = Array.from(
      { length: 40 },
      (_, index) => `deep-${index}`
    ).join("/");
    expect(deepDirectory.length).toBeGreaterThan(MAX_DESCRIBED_VALUE_LENGTH);
    const relPath = `${deepDirectory}/note.md`;
    await mkdir(join(root, deepDirectory), { recursive: true });
    await Bun.write(join(root, relPath), "# note\n");

    const harness = createReconcileHarness(createCollection("notes", root), {
      store: createSubtreeStore({ direct: { [deepDirectory]: [relPath] } })
        .store,
      syncResult: (batchedPaths) =>
        createSyncResult({
          filesProcessed: batchedPaths.length,
          files: batchedPaths.map((batchedPath) => ({
            relPath: batchedPath,
            status: "skipped",
          })),
          // Attributable: every error is owned by a batched path. Otherwise a
          // single collection-level failure no batched path owns.
          errors: attributable
            ? batchedPaths.map((batchedPath) => ({
                relPath: batchedPath,
                code: "WRITE_FAILED",
                message: "disk full",
              }))
            : [
                {
                  relPath: "(typed edge backfill)",
                  code: "QUERY_FAILED",
                  message: "backfillDocEdges failed",
                },
              ],
        }),
    });

    try {
      harness.service.start();
      harness.emit([["rename", `${deepDirectory}/note.md.tmp`]]);
      expect(await harness.settle()).toBe("settled");
      const causes = harness.failed.map((event) =>
        String((event.cause as Error | undefined)?.message)
      );
      expect(causes).toHaveLength(1);
      return { cause: causes[0] ?? "", deepDirectory };
    } finally {
      await harness.service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }

  test(
    "bounds the reconciled directory in an attributable cause",
    async () => {
      const { cause, deepDirectory } = await runDeepDirectoryFailure(true);

      expect(cause).toContain("sync reported");
      expect(cause).toContain(
        `${deepDirectory.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...`
      );
      expect(cause).not.toContain(`"${deepDirectory}"`);
      expect(cause.length).toBeLessThan(BOUNDED_CAUSE_LIMIT);
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "bounds the reconciled directory in an unattributable cause",
    async () => {
      const { cause, deepDirectory } = await runDeepDirectoryFailure(false);

      expect(cause).toContain("attribution was impossible");
      expect(cause).toContain(
        `${deepDirectory.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}...`
      );
      expect(cause).not.toContain(`"${deepDirectory}"`);
      expect(cause.length).toBeLessThan(BOUNDED_CAUSE_LIMIT);
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * Epoch milliseconds cannot order an event against a `suppress()` call made in
 * the same millisecond, so membership answered as `startMs <= atMs` let a window
 * opened just AFTER an event suppress it retroactively - the exact defect
 * interval membership exists to remove, surviving at millisecond scale.
 *
 * The fix is a second, causal reading: both events and `suppress()` draw from
 * one monotonic sequence, and the window's START is recorded in it (R4).
 */
describe("CollectionWatchService orders events against same-millisecond suppression", () => {
  test(
    "reconciles a candidate whose event precedes suppress() within one millisecond",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-same-ms-"));
      // A genuine external edit, reported only under its atomic temp name.
      await Bun.write(join(root, "note.md"), "# edited in an editor\n");
      const { store } = createSubtreeStore({ direct: { "": ["note.md"] } });
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      const realNow = Date.now;
      const frozenMs = realNow();
      try {
        harness.service.start();
        // Both readings collapse onto one millisecond, which is the boundary a
        // wall clock cannot resolve. The ORDER is unambiguous: the event
        // happened, and only then did GNO open its window.
        Date.now = () => frozenMs;
        harness.emit([["rename", "note.md.tmp"]]);
        harness.service.suppress(join(root, "note.md"), 5_000);
        Date.now = realNow;

        expect(await harness.settle()).toBe("settled");

        // `startMs <= atMs` classified this external change as GNO's own write
        // and dropped it in silence.
        expect(harness.batches).toEqual([["note.md"]]);
      } finally {
        Date.now = realNow;
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * Suppression history is reclaimed OPPORTUNISTICALLY - on `suppress()` and at
 * the end of every flush - which bounds it at one retained entry per suppressed
 * path. These pin that bound, and pin that the O(1) scan guard cannot be left
 * naming an expiry the history no longer has (R4).
 */
describe("CollectionWatchService bounds retained suppression history", () => {
  test(
    "reclaims a window closed early instead of waiting for its original expiry",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-close-reclaim-"));
      const { store } = createSubtreeStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // A long window, then the documented early close.
        harness.service.suppress(join(root, "note.md"), 60_000);
        expect(harness.service.retainedSuppressionPathCount).toBe(1);

        // `suppress(path, 0)` ends the window NOW, so the very reclamation it
        // triggers must see it as closed. Tracking the scan floor only on the
        // windows that OPEN left it naming the 60 s expiry, and the O(1) guard
        // then skipped this scan entirely - the closed window stayed retained
        // for another minute.
        harness.service.suppress(join(root, "note.md"), 0);
        expect(harness.service.retainedSuppressionPathCount).toBe(0);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "keeps at most one entry per suppressed path and drops lapsed ones at flush end",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-flush-reclaim-"));
      await Bun.write(join(root, "note.md"), "# note\n");
      const { store } = createSubtreeStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        const lapsed = join(root, "lapsed.md");
        // Many windows on ONE path collapse into one retained entry: repeated
        // application writes cannot grow the history per write.
        for (let index = 0; index < 20; index += 1) {
          harness.service.suppress(lapsed, 5);
        }
        expect(harness.service.retainedSuppressionPathCount).toBe(1);
        await Bun.sleep(25);

        // A flush is the other reclamation trigger, and it runs after the
        // window it could still have been asked about has lapsed.
        harness.emit([["change", "note.md"]]);
        expect(await harness.settle()).toBe("settled");
        expect(harness.service.retainedSuppressionPathCount).toBe(0);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * The debounce must DELAY work, never prevent it.
 *
 * Every event re-arms the single flush timer, so a process emitting unique
 * names faster than the 300 ms window (an editor's temp files, a build's
 * intermediates, a sync client) cancelled and restarted that timer forever:
 * the flush never ran, eligible edits queued beside the churn were never
 * synced at all, and the queues - `DirtyDirectoryEntry.hints` in particular -
 * grew for exactly as long as the churn lasted. A ceiling measured from the
 * window's FIRST event is what bounds both, without changing what a normal
 * burst does.
 */
describe("CollectionWatchService flush deadline", () => {
  test(
    "flushes queued work under churn faster than the debounce",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-starvation-"));
      await Bun.write(join(root, "note.md"), "# note\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });
      let churn: ReturnType<typeof setInterval> | null = null;

      try {
        harness.service.start();
        const startedAt = Date.now();
        // The eligible edit that must not be starved.
        harness.emit([["change", "note.md"]]);

        // Unique ineligible temp names, comfortably faster than the debounce.
        // Never the same name twice: coalescing is not what is under test, the
        // timer re-arm is.
        let emitted = 0;
        churn = setInterval(() => {
          emitted += 1;
          harness.emit([["rename", `note.md.tmp.${emitted}`]]);
        }, 50);

        // Not a sleep standing in for synchronization: the loop waits on the
        // batch itself and only bounds a hang. Pre-fix it runs to the bound
        // and finds nothing, because no flush ever happens.
        const hangBoundMs = 6000;
        while (
          harness.batches.length === 0 &&
          Date.now() - startedAt < hangBoundMs
        ) {
          await Bun.sleep(25);
        }
        const elapsedMs = Date.now() - startedAt;
        clearInterval(churn);
        churn = null;

        expect(emitted).toBeGreaterThan(5);
        expect(harness.batches[0] ?? []).toContain("note.md");
        // Delayed, not starved...
        expect(elapsedMs).toBeGreaterThanOrEqual(300);
        // ...and bounded by the ceiling, with slack for the sync itself.
        expect(elapsedMs).toBeLessThan(4000);
      } finally {
        if (churn) {
          clearInterval(churn);
        }
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );

  test(
    "still coalesces a burst spread across several debounce windows",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-burst-coalesce-"));
      await Bun.write(join(root, "note.md"), "# note\n");
      const { store, roundTrips } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });

      try {
        harness.service.start();
        // Six events at 100 ms - each one re-arms the debounce, and the whole
        // burst finishes inside the ceiling. The ceiling must not chop this
        // into several batches: that would be a coalescing regression dressed
        // up as a starvation fix.
        for (let index = 0; index < 6; index += 1) {
          harness.emit([["rename", `note.md.tmp.${index}`]]);
          await Bun.sleep(100);
        }
        expect(await harness.settle()).toBe("settled");

        expect(harness.batches).toEqual([["note.md"]]);
        expect(roundTrips).toHaveLength(1);
        expect(harness.started).toEqual([
          { collection: "notes", directory: "" },
        ]);
      } finally {
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * The ceiling is a promise about elapsed time, so it may not be measured with
 * a clock that can move backward.
 *
 * `Date.now()` steps (NTP, a manual change, a resume). While churn keeps
 * re-arming the debounce, every backward step makes `deadline - now` LARGER, so
 * the delay stays at the full debounce and the window never reaches its
 * deadline - the starvation the ceiling exists to prevent, reintroduced by the
 * clock rather than by the event rate.
 */
describe("CollectionWatchService flush deadline uses a monotonic clock", () => {
  test(
    "flushes within the ceiling while the wall clock runs backward",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gno-watch-clock-back-"));
      await Bun.write(join(root, "note.md"), "# note\n");
      const { store } = createRecordingStore({});
      const harness = createReconcileHarness(createCollection("notes", root), {
        store,
      });
      const realDateNow = Date.now;
      let churn: ReturnType<typeof setInterval> | null = null;

      try {
        harness.service.start();
        // Measured monotonically: the assertion is about real elapsed time, not
        // about the clock the test is deliberately corrupting.
        const startedAt = performance.now();
        harness.emit([["change", "note.md"]]);

        // The wall clock walks backward faster than real time passes, for as
        // long as the churn lasts.
        let rewindMs = 0;
        Date.now = () => realDateNow() - rewindMs;
        let emitted = 0;
        churn = setInterval(() => {
          emitted += 1;
          rewindMs += 500;
          harness.emit([["rename", `note.md.tmp.${emitted}`]]);
        }, 50);

        // Waits on the batch itself; the bound only stops a hang. Pre-fix it
        // runs to the bound and finds nothing.
        const hangBoundMs = 6000;
        while (
          harness.batches.length === 0 &&
          performance.now() - startedAt < hangBoundMs
        ) {
          await Bun.sleep(25);
        }
        const elapsedMs = performance.now() - startedAt;
        clearInterval(churn);
        churn = null;
        Date.now = realDateNow;

        expect(emitted).toBeGreaterThan(5);
        // The rewind outran the 2 s ceiling itself, so a wall-clock deadline
        // could not have been reached at any point in this window.
        expect(rewindMs).toBeGreaterThan(2000);
        expect(harness.batches[0] ?? []).toContain("note.md");
        // Delayed by the debounce, bounded by the ceiling, with slack for the
        // sync itself - the same envelope the well-behaved-clock test asserts.
        expect(elapsedMs).toBeGreaterThanOrEqual(300);
        expect(elapsedMs).toBeLessThan(4000);
      } finally {
        Date.now = realDateNow;
        if (churn) {
          clearInterval(churn);
        }
        await harness.service.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    RED_TEST_TIMEOUT_MS
  );
});

/**
 * An indexed real directory replaced by an IN-ROOT SYMLINK, end to end against
 * a real filesystem, a real SQLite store and the real `syncPaths`.
 *
 * `FileWalker.walk` never descends into a symlinked directory, so a full
 * `gno update` deactivates everything it had indexed under `dir/` the moment
 * `dir` becomes `dir -> real`. The watcher has to reach the SAME conclusion,
 * and enumeration parity alone does not get it there: reporting "no eligible
 * children on disk" only empties the DISK half of the union, and the indexed
 * half then reaches `syncPaths`, which stats `dir/note.md`, FOLLOWS the alias,
 * finds a live file and keeps the document active. A full update and the
 * watcher then disagree about what is indexed - the exact divergence fn-114
 * exists to remove.
 *
 * The watcher is driven through a fake `watchFactory` so the replacement is
 * fully in place before the event is delivered: with the real watcher the
 * transient "directory is momentarily gone" state can converge the same
 * outcome by a different route, which would make the test's discrimination a
 * matter of interleaving. Nothing else is faked - the store, the filesystem,
 * the enumeration and the sync are all real.
 *
 * Against a2f75504 this fails on the first assertion (`dir/note.md` is still
 * active, because `syncPaths` followed the alias). Discriminating, not a
 * direction pin.
 */
describe("symlink replacement converges the indexed side", () => {
  test("deactivates indexed children of a directory replaced by an in-root symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-symlink-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "dir"), { recursive: true });
    await Bun.write(join(root, "dir", "note.md"), "# note\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let service: CollectionWatchService | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      // A real initial sync, exactly as a `gno update` before the daemon starts.
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const indexed = await store.getDocument(collection.name, "dir/note.md");
      expect(indexed.ok && indexed.value?.active).toBe(true);

      let watcherCallback:
        | ((eventType: string, filename: string | null) => void)
        | undefined;
      let notifySettled: (() => void) | null = null;
      service = new CollectionWatchService({
        collections: [collection],
        eventBus: null as never,
        scheduler: null as never,
        store: store as never,
        callbacks: {
          onSettled: () => {
            const resolve = notifySettled;
            notifySettled = null;
            resolve?.();
          },
        },
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

      // Replace the indexed real directory with an in-root alias to an
      // identical tree. `dir/note.md` still STATS fine through the alias; only
      // a no-follow traversal can tell the difference.
      await mkdir(join(root, "real"), { recursive: true });
      await Bun.write(join(root, "real", "note.md"), "# note\n");
      await rm(join(root, "dir"), { recursive: true, force: true });
      await symlink(join(root, "real"), join(root, "dir"), "dir");

      const settled = new Promise<"settled">((resolve) => {
        notifySettled = () => resolve("settled");
      });
      // `dir` is ineligible against `**/*.md`, so it arrives as a directory
      // HINT - the ordinary route for a renamed directory.
      watcherCallback?.("rename", "dir");
      expect(
        await Promise.race([
          settled,
          Bun.sleep(15_000).then(() => "NO_SETTLE_WITHIN_TIMEOUT" as const),
        ])
      ).toBe("settled");

      const afterWatch = await store.getDocument(
        collection.name,
        "dir/note.md"
      );
      expect(afterWatch.ok && afterWatch.value?.active).toBe(false);

      // ...and that is the same conclusion a full walk reaches, which is the
      // whole point: the two halves of the product must not disagree.
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const afterFullSync = await store.getDocument(
        collection.name,
        "dir/note.md"
      );
      expect(afterFullSync.ok && afterFullSync.value?.active).toBe(false);
    } finally {
      await service?.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The same convergence when the replacement link ESCAPES the collection.
   *
   * This is the case traversal containment made worse. The enumeration
   * classified the entry point by RESOLVING it first, so a link pointing
   * outside the root was reported as an enumeration `error` rather than
   * `skipped` - and `error` is fail-closed by design, so the reconciliation
   * produced no candidates at all and every document indexed under `dir/`
   * stayed active. A full no-follow walk removes all of them, which is exactly
   * the divergence fn-114 exists to close.
   *
   * The fix classifies a provable symlink WITHOUT reading or resolving the
   * target, so containment is not weakened - nothing is read through the link
   * in either version. Genuine unreadable/IO failures keep the `error` path;
   * that is pinned by "fails closed on an unreadable directory, reports it, and
   * stays armed" above, which is unchanged.
   *
   * Against 538e3047 the first assertion fails (`dir/note.md` is still active).
   * Discriminating, not a direction pin.
   */
  test("deactivates indexed children of a directory replaced by an ESCAPING symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-symlink-out-"));
    const root = join(tempDir, "collection");
    // The link target lives OUTSIDE the collection root, and it really exists -
    // so a following `stat` on `dir/note.md` succeeds throughout.
    const outside = join(tempDir, "outside");
    await mkdir(join(root, "dir"), { recursive: true });
    await Bun.write(join(root, "dir", "note.md"), "# note\n");
    await mkdir(outside, { recursive: true });
    await Bun.write(join(outside, "note.md"), "# note\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let service: CollectionWatchService | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const indexed = await store.getDocument(collection.name, "dir/note.md");
      expect(indexed.ok && indexed.value?.active).toBe(true);

      let watcherCallback:
        | ((eventType: string, filename: string | null) => void)
        | undefined;
      let notifySettled: (() => void) | null = null;
      service = new CollectionWatchService({
        collections: [collection],
        eventBus: null as never,
        scheduler: null as never,
        store: store as never,
        callbacks: {
          onSettled: () => {
            const resolve = notifySettled;
            notifySettled = null;
            resolve?.();
          },
        },
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

      await rm(join(root, "dir"), { recursive: true, force: true });
      await symlink(outside, join(root, "dir"), "dir");

      const settled = new Promise<"settled">((resolve) => {
        notifySettled = () => resolve("settled");
      });
      watcherCallback?.("rename", "dir");
      expect(
        await Promise.race([
          settled,
          Bun.sleep(15_000).then(() => "NO_SETTLE_WITHIN_TIMEOUT" as const),
        ])
      ).toBe("settled");

      const afterWatch = await store.getDocument(
        collection.name,
        "dir/note.md"
      );
      expect(afterWatch.ok && afterWatch.value?.active).toBe(false);

      // The full walk reaches the same conclusion, which is the guarantee.
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const afterFullSync = await store.getDocument(
        collection.name,
        "dir/note.md"
      );
      expect(afterFullSync.ok && afterFullSync.value?.active).toBe(false);
    } finally {
      await service?.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The rest of fn-114's symlink convergence, driven end to end against a real
 * filesystem, a real SQLite store and the REAL `syncPaths`.
 *
 * These pin the mechanism after it moved. The no-follow policy now lives in
 * `checkWalkPathVisibility`, beside the eligibility rules, and is enforced by
 * `syncPaths` itself - so the watcher deactivates an unreachable path through
 * the ORDINARY batch rather than through a private store-mutation path of its
 * own. Everything the ordinary batch provides therefore applies, and each test
 * below pins one thing the private path did not have.
 */
function createLiveWatchHarness(
  collection: Collection,
  store: unknown,
  options: {
    eventBus?: { emit: (event: unknown) => void } | null;
    scheduler?: { notifySyncComplete: (relPaths: string[]) => void } | null;
    resolveVanishedPath?: (
      relPath: string,
      root: string
    ) => Promise<VanishedPathOutcome>;
    onSyncComplete?: (event: { result: CollectionSyncResult }) => void;
  } = {}
) {
  let watcherCallback:
    | ((eventType: string, filename: string | null) => void)
    | undefined;
  let notifySettled: (() => void) | null = null;

  const service = new CollectionWatchService({
    collections: [collection],
    eventBus: (options.eventBus ?? null) as never,
    scheduler: (options.scheduler ?? null) as never,
    store: store as never,
    callbacks: {
      onSettled: () => {
        const resolve = notifySettled;
        notifySettled = null;
        resolve?.();
      },
      onSyncComplete: options.onSyncComplete as never,
    },
    watchFactory: ((
      _path: string,
      _watchOptions: { recursive: boolean },
      callback: WatchListener<string>
    ) => {
      watcherCallback = callback as typeof watcherCallback;
      return { close: () => undefined };
    }) as never,
    resolveVanishedPath: options.resolveVanishedPath,
  });

  return {
    service,
    emitAndSettle: async (
      sequence: ReadonlyArray<readonly [string, string | null]>
    ): Promise<"settled" | "NO_SETTLE_WITHIN_TIMEOUT"> => {
      const settled = new Promise<"settled">((resolve) => {
        notifySettled = () => resolve("settled");
      });
      for (const [eventType, filename] of sequence) {
        watcherCallback?.(eventType, filename);
      }
      return await Promise.race([
        settled,
        Bun.sleep(20_000).then(() => "NO_SETTLE_WITHIN_TIMEOUT" as const),
      ]);
    },
  };
}

describe("the no-follow policy converges through the ordinary sync batch", () => {
  /**
   * An ELIGIBLE-NAMED directory replaced by a symlink (`archive.md -> real/`).
   *
   * The name matters, and it is the whole point of this case. `archive.md`
   * matches `**\/*.md`, so its event takes the EXACT-PATH branch, never the
   * directory-hint branch the previous test uses. That branch asked the disk
   * "is this path still here?" with a FOLLOWING `stat`, which succeeds through
   * the alias, so the path resolved as `present`, nothing was ever widened, and
   * every document indexed under `archive.md/` stayed active - untouched by the
   * enumeration-side fix, which that branch never reaches. Naming the directory
   * `dir` (ineligible) is exactly what hid this.
   *
   * Now the existence question is `walkerVisible`, so the alias reads as gone to
   * the walker, `archive.md` is retained as a hint, its indexed descendants are
   * found, and `syncPaths` deactivates them under the same policy.
   *
   * DISCRIMINATING against 0c517f7f: there this fails on `afterWatch`, because
   * the exact-path branch stats through the alias, reports `present`, and the
   * descendant is never implicated at all.
   */
  test("converges an eligible-NAMED directory replaced by a symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-eligible-name-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "archive.md"), { recursive: true });
    await Bun.write(join(root, "archive.md", "note.md"), "# note\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let harness: ReturnType<typeof createLiveWatchHarness> | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const indexed = await store.getDocument(
        collection.name,
        "archive.md/note.md"
      );
      expect(indexed.ok && indexed.value?.active).toBe(true);

      harness = createLiveWatchHarness(collection, store);
      harness.service.start();

      await mkdir(join(root, "real"), { recursive: true });
      await Bun.write(join(root, "real", "note.md"), "# note\n");
      await rm(join(root, "archive.md"), { recursive: true, force: true });
      await symlink(join(root, "real"), join(root, "archive.md"), "dir");

      // The reported name is ELIGIBLE, so this is the exact-path branch.
      expect(await harness.emitAndSettle([["rename", "archive.md"]])).toBe(
        "settled"
      );

      const afterWatch = await store.getDocument(
        collection.name,
        "archive.md/note.md"
      );
      expect(afterWatch.ok && afterWatch.value?.active).toBe(false);

      // The same conclusion a full walk reaches - the halves must agree.
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const afterFullSync = await store.getDocument(
        collection.name,
        "archive.md/note.md"
      );
      expect(afterFullSync.ok && afterFullSync.value?.active).toBe(false);
    } finally {
      await harness?.service.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * A recreated subtree whose recreation contains a NESTED symlink directory.
   *
   * `dir/gone/` is removed while holding an indexed `dir/gone/nested/note.md`,
   * so the flush classifies it as a removed subtree; it is then recreated - with
   * `nested` now an alias - before the enumeration runs. That is the window the
   * subtree enumeration exists for, and it is driven at the one awaited point
   * that defines it (the classification seam) rather than raced against a sleep.
   *
   * The recursive enumeration walks into the recreated `dir/gone`, sees
   * `nested` as a symlink `Dirent` and omits it silently - it reports no
   * `skipped`, and it should not have to: the indexed side still supplies
   * `dir/gone/nested/note.md`, and `syncPaths` refuses to follow it. That is the
   * value of putting the policy at the ingestion seam instead of at the
   * enumeration seam: enumeration never has to enumerate what it cannot see.
   *
   * DISCRIMINATING against 0c517f7f: there the enumeration omits `nested` in
   * exactly the same way, and `syncPaths` then STATS `dir/gone/nested/note.md`,
   * follows the alias, finds the target's file and REINDEXES it - the document
   * stays active, so the final assertion fails.
   */
  test("converges a recreated subtree containing a NESTED symlink directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-nested-symlink-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "dir", "gone", "nested"), { recursive: true });
    await Bun.write(
      join(root, "dir", "gone", "nested", "note.md"),
      "# nested\n"
    );
    await mkdir(join(root, "real"), { recursive: true });
    await Bun.write(join(root, "real", "note.md"), "# target\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let harness: ReturnType<typeof createLiveWatchHarness> | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const indexed = await store.getDocument(
        collection.name,
        "dir/gone/nested/note.md"
      );
      expect(indexed.ok && indexed.value?.active).toBe(true);

      let recreated = false;
      harness = createLiveWatchHarness(collection, store, {
        resolveVanishedPath: async (relPath, watchedRoot) => {
          const outcome = await resolveVanishedPathDirectory(
            relPath,
            watchedRoot
          );
          if (!recreated) {
            recreated = true;
            // The removal has been classified; recreate the subtree with the
            // alias in place before the enumeration reads it.
            await mkdir(join(root, "dir", "gone"), { recursive: true });
            await symlink(
              join(root, "real"),
              join(root, "dir", "gone", "nested"),
              "dir"
            );
          }
          return outcome;
        },
      });
      harness.service.start();

      await rm(join(root, "dir", "gone"), { recursive: true, force: true });
      expect(
        await harness.emitAndSettle([["rename", "dir/gone/nested/note.md"]])
      ).toBe("settled");

      expect(recreated).toBe(true);
      const afterWatch = await store.getDocument(
        collection.name,
        "dir/gone/nested/note.md"
      );
      expect(afterWatch.ok && afterWatch.value?.active).toBe(false);
    } finally {
      await harness?.service.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * A large subtree, and the WIDTH of the statements that deactivate it.
   *
   * The private deactivation path collected the whole subtree and handed it to
   * ONE `markInactive`, which binds one host parameter per path - so the
   * statement grew without bound with the size of the aliased directory. Going
   * through `syncPaths` instead means one `markInactive` PER SOURCE PATH, which
   * is the chunking the rest of this repo already relies on.
   *
   * On the ceiling, measured rather than assumed: bun:sqlite here accepts 65535
   * bound values and fails above that (`SELECT ... IN (?...)` with 65536+), NOT
   * at the 999 of SQLite's old compile-time default. So a 1200-path statement
   * does not actually throw on this runtime, and this test does not pretend it
   * does. What it pins is the property that made the ceiling reachable at all:
   * after this change the widest statement is a single source path's own
   * documents, so no subtree size can reach any limit.
   *
   * DISCRIMINATING against 0c517f7f: there one `markInactive` carries all 1200
   * paths, so `widest` is 1200 and the width assertion fails. (The convergence
   * assertion alone would NOT discriminate on this runtime - 1200 bindings still
   * succeed - which is exactly why the width is asserted too.)
   */
  test("deactivates a large subtree without an unbounded statement", async () => {
    const documentCount = 1200;
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-large-subtree-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "dir"), { recursive: true });
    await Promise.all(
      Array.from({ length: documentCount }, (_unused, index) =>
        Bun.write(join(root, "dir", `note-${index}.md`), `# note ${index}\n`)
      )
    );

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let harness: ReturnType<typeof createLiveWatchHarness> | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });
      const before = await store.listDocuments(collection.name);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(
        before.value.filter(
          (document) =>
            document.active && document.relPath.startsWith("dir/note-")
        ).length
      ).toBe(documentCount);

      // A real store with ONE seam observed, so the statement WIDTH is a
      // property of the run rather than something inferred from the code.
      const widths: number[] = [];
      const observedStore = Object.create(store) as SqliteAdapter;
      observedStore.markInactive = (
        collectionName: string,
        relPaths: string[]
      ) => {
        widths.push(relPaths.length);
        return store.markInactive(collectionName, relPaths);
      };

      harness = createLiveWatchHarness(collection, observedStore);
      harness.service.start();

      await mkdir(join(root, "real"), { recursive: true });
      await rm(join(root, "dir"), { recursive: true, force: true });
      await symlink(join(root, "real"), join(root, "dir"), "dir");

      expect(await harness.emitAndSettle([["rename", "dir"]])).toBe("settled");

      expect(widths.length).toBeGreaterThan(0);
      expect(Math.max(...widths)).toBe(1);

      const after = await store.listDocuments(collection.name);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(
        after.value.filter(
          (document) =>
            document.active && document.relPath.startsWith("dir/note-")
        )
      ).toEqual([]);
    } finally {
      await harness?.service.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 300_000);

  /**
   * The observable side effects of a deactivation taken by this route.
   *
   * The private path returned NO candidates, so the flush read the whole
   * reconciliation as a no-op: `syncPaths` was never called, `lastSyncAt` never
   * advanced, the scheduler was never notified, no `document-changed` event was
   * emitted, and the sync result reported nothing marked inactive. A document
   * silently vanished from search with no trace anywhere a consumer can see.
   *
   * DISCRIMINATING against 0c517f7f: every one of these assertions fails there -
   * the events array is empty, `lastSyncAt` is null, the scheduler saw nothing,
   * and there is no sync result to inspect at all.
   */
  test("emits the ordinary events, status and count for this deactivation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-symlink-events-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "dir"), { recursive: true });
    await Bun.write(join(root, "dir", "note.md"), "# note\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    const events: Array<{ type: string; relPath: string }> = [];
    const notified: string[][] = [];
    const results: CollectionSyncResult[] = [];
    let harness: ReturnType<typeof createLiveWatchHarness> | null = null;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });

      harness = createLiveWatchHarness(collection, store, {
        eventBus: {
          emit: (event) => {
            events.push(event as { type: string; relPath: string });
          },
        },
        scheduler: {
          notifySyncComplete: (relPaths) => {
            notified.push([...relPaths]);
          },
        },
        onSyncComplete: (event) => {
          results.push(event.result);
        },
      });
      harness.service.start();
      expect(harness.service.getState().lastSyncAt).toBeNull();

      await mkdir(join(root, "real"), { recursive: true });
      await rm(join(root, "dir"), { recursive: true, force: true });
      await symlink(join(root, "real"), join(root, "dir"), "dir");

      expect(await harness.emitAndSettle([["rename", "dir"]])).toBe("settled");

      expect(
        events.filter(
          (event) =>
            event.type === "document-changed" && event.relPath === "dir/note.md"
        ).length
      ).toBe(1);
      expect(notified).toEqual([["dir/note.md"]]);
      expect(harness.service.getState().lastSyncAt).not.toBeNull();
      expect(
        results.reduce((total, result) => total + result.filesMarkedInactive, 0)
      ).toBeGreaterThan(0);
    } finally {
      await harness?.service.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * A configuration change landing DURING the indexed-side lookup.
   *
   * The private path mutated the store before the flush's outer
   * `resumeAfterAwait()` generation check ever ran, so a collection removed or
   * moved mid-flight had its documents deactivated anyway, against a
   * configuration that no longer existed (R6). Going through the ordinary batch
   * puts the deactivation AFTER that check, so the stale work is dropped whole.
   *
   * The drift is triggered from inside the awaited store seam - the same
   * controllable point the existing mid-enumeration drift tests use - so nothing
   * is timed against a sleep.
   *
   * DISCRIMINATING against 0c517f7f: there `dir/note.md` is already inactive by
   * the time the generation check runs, so the final assertion fails.
   */
  test("drops the deactivation when the collection is removed during the lookup", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-watch-symlink-drift-"));
    const root = join(tempDir, "collection");
    await mkdir(join(root, "dir"), { recursive: true });
    await Bun.write(join(root, "dir", "note.md"), "# note\n");

    const collection = createCollection("notes", root);
    const store = new SqliteAdapter();
    let harness: ReturnType<typeof createLiveWatchHarness> | null = null;
    let dropped = false;
    try {
      expect(
        (await store.open(join(tempDir, "index.sqlite"), "porter")).ok
      ).toBe(true);
      expect((await store.syncCollections([collection])).ok).toBe(true);
      await defaultSyncService.syncCollection(collection, store, {
        runUpdateCmd: false,
      });

      // A real store, with ONE seam wrapped so the configuration can change at
      // exactly the awaited point the indexed side is resolved.
      const driftingStore = Object.create(store) as SqliteAdapter & {
        listActiveDescendantSourcePathsBatch: SqliteAdapter["listActiveDescendantSourcePathsBatch"];
      };
      driftingStore.listActiveDescendantSourcePathsBatch = async (
        ...args: Parameters<
          SqliteAdapter["listActiveDescendantSourcePathsBatch"]
        >
      ) => {
        const answer = await store.listActiveDescendantSourcePathsBatch(
          ...args
        );
        if (!dropped) {
          dropped = true;
          harness?.service.updateCollections([]);
        }
        return answer;
      };

      harness = createLiveWatchHarness(collection, driftingStore);
      harness.service.start();

      await mkdir(join(root, "real"), { recursive: true });
      await rm(join(root, "dir"), { recursive: true, force: true });
      await symlink(join(root, "real"), join(root, "dir"), "dir");

      expect(await harness.emitAndSettle([["rename", "dir"]])).toBe("settled");

      expect(dropped).toBe(true);
      // The collection no longer exists, so no store mutation may be made on
      // the strength of work resolved against the configuration that did.
      const afterDrift = await store.getDocument(
        collection.name,
        "dir/note.md"
      );
      expect(afterDrift.ok && afterDrift.value?.active).toBe(true);
    } finally {
      await harness?.service.dispose();
      await store.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
