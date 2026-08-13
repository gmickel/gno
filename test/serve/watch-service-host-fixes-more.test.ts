/**
 * Host review round-1 regressions for CollectionWatchService integration.
 */

import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, mock, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import {
  applyCollectionUpdate,
  clearLifecycleTombstones,
  type WatchLifecycleHost,
} from "../../src/serve/watch-service-lifecycle";
import { safeRm } from "../helpers/cleanup";

function createCollection(
  name: string,
  path: string,
  overrides: Partial<Collection> = {}
): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    ...overrides,
  };
}

function createStubStore(
  overrides: Partial<SqliteAdapter> = {}
): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
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

describe("ambiguous suppression after dirty classify", () => {
  test("suppressed final path from temp event does not sync; no duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-supp-temp-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const syncPaths = mock(async () => createSyncResult());
    defaultSyncService.syncPaths =
      syncPaths as typeof defaultSyncService.syncPaths;
    try {
      await writeFile(join(root, "note.md"), "x");
      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 150,
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
      await Bun.sleep(80);
      service.suppress(join(root, "note.md"), 5_000);
      watcherCallback?.("rename", "note.md.tmp");
      await Bun.sleep(350);
      expect(syncPaths).not.toHaveBeenCalled();
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("suppressed path from null root event does not sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-supp-null-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const syncPaths = mock(async () => createSyncResult());
    defaultSyncService.syncPaths =
      syncPaths as typeof defaultSyncService.syncPaths;
    try {
      await writeFile(join(root, "only.md"), "x");
      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 150,
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
      await Bun.sleep(80);
      service.suppress(join(root, "only.md"), 5_000);
      watcherCallback?.("change", null);
      await Bun.sleep(350);
      expect(syncPaths).not.toHaveBeenCalled();
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("pattern-matching directory exact path", () => {
  test("folder.md directory with eligible child dirties without NOT_FILE", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-folder-md-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    const onSyncError = mock(() => undefined);
    try {
      await mkdir(join(root, "folder.md"), { recursive: true });
      await writeFile(join(root, "folder.md", "child.md"), "c");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        callbacks: { onSyncError },
        flushDebounceMs: 40,
        maxFlushDelayMs: 200,
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
      await Bun.sleep(80);
      watcherCallback?.("change", "folder.md");
      await Bun.sleep(400);
      expect(onSyncError).not.toHaveBeenCalled();
      // Directory itself must not be submitted as an exact file path.
      expect(seen.every((batch) => !batch.includes("folder.md"))).toBe(true);
      expect(seen.some((batch) => batch.includes("folder.md/child.md"))).toBe(
        true
      );
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("lifecycle map tombstones", () => {
  test("repeated unique add/remove churn does not retain generation/failed maps", () => {
    const generations = new Map<string, number>();
    const fingerprints = new Map<string, string>();
    const failed = new Map<string, string>();
    const watchers = new Map<string, { close: () => void }>();
    const watchRoots = new Map<string, string>();
    const snapshots = new Map();
    const snapshotReady = new Map<string, boolean>();
    const snapshotInit = new Map<string, Promise<void>>();
    const syncing = new Set<string>();
    let collections: Collection[] = [];
    let nextGen = 0;
    let syncOptions = {};

    const host: WatchLifecycleHost = {
      disposed: () => false,
      getCollections: () => collections,
      setCollections: (next) => {
        collections = next;
      },
      getSyncOptions: () => syncOptions,
      setSyncOptions: (next) => {
        syncOptions = next;
      },
      watchers: watchers as never,
      watchRoots,
      collectionFingerprints: fingerprints,
      collectionGenerations: generations,
      nextGeneration: () => ++nextGen,
      failedCollections: failed,
      snapshots: snapshots as never,
      snapshotReady,
      snapshotInit,
      syncing,
      pendingByCollection: new Map(),
      clearCollectionRuntimeState: (name) => {
        watchRoots.delete(name);
        snapshots.delete(name);
        snapshotReady.delete(name);
        snapshotInit.delete(name);
      },
      beginSnapshotInit: () => undefined,
      watchFactory: (() => ({ close: () => undefined })) as never,
      onWatchEvent: () => undefined,
    };

    for (let i = 0; i < 40; i += 1) {
      const name = `c${i}`;
      applyCollectionUpdate(host, [createCollection(name, `/tmp/${name}`)]);
      // Force a failed entry then remove.
      failed.set(name, "watch unavailable");
      applyCollectionUpdate(host, []);
      clearLifecycleTombstones(host, name);
    }

    expect(generations.size).toBe(0);
    expect(fingerprints.size).toBe(0);
    expect(failed.size).toBe(0);
    expect(watchers.size).toBe(0);
  });
});
