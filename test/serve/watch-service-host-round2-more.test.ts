/**
 * Host review round-2 regressions: ownership guard and readiness (no 10ms poll).
 */

import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
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

describe("ownership guard", () => {
  test("old in-flight flush after removal does not requeue or keep tombstones", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-own-rm-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await writeFile(join(root, "note.md"), "x");
      defaultSyncService.syncPaths = (async () => {
        await gate;
        return createSyncResult({
          filesErrored: 1,
          files: [{ relPath: "note.md", status: "error", errorCode: "FAIL" }],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 100,
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
      await Bun.sleep(40);
      watcherCallback?.("change", "note.md");
      await Bun.sleep(150);
      service.updateCollections([]);
      finish?.();
      await Bun.sleep(800);
      expect(service.getState().queuedCollections).toEqual([]);
      expect(service.getState().expectedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("repeated unique remove-during-sync churn stays bounded", async () => {
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

    for (let i = 0; i < 60; i += 1) {
      const name = `c${i}`;
      applyCollectionUpdate(host, [createCollection(name, `/tmp/${name}`)]);
      syncing.add(name);
      applyCollectionUpdate(host, []);
      syncing.delete(name);
      clearLifecycleTombstones(host, name);
    }

    expect(generations.size).toBe(0);
    expect(fingerprints.size).toBe(0);
    expect(failed.size).toBe(0);
    expect(watchers.size).toBe(0);
    expect(watchRoots.size).toBe(0);
  });
});

describe("no readiness polling", () => {
  test("dirty before ready leaves queued work; onReady schedules once", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-ready-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    let resolveInit: (() => void) | undefined;
    const initGate = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    let buildCalls = 0;
    const seen: string[][] = [];
    const setTimeoutCalls: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    try {
      await writeFile(join(root, "doc.md"), "final");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;

      globalThis.setTimeout = ((
        handler: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (typeof delay === "number") {
          setTimeoutCalls.push(delay);
        }
        return realSetTimeout(handler, delay, ...args);
      }) as typeof setTimeout;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore({
          listActiveSourcePaths: async () => ({ ok: true, value: ["doc.md"] }),
          listActiveDirectChildSourcePaths: async () => ({
            ok: true,
            value: ["doc.md"],
          }),
        }),
        flushDebounceMs: 30,
        maxFlushDelayMs: 200,
        buildSnapshot: async () => {
          buildCalls += 1;
          await initGate;
          return {
            status: "fallback",
            reason: "scan_failed",
            durationMs: 1,
            cause: new Error("slow init"),
          };
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
      watcherCallback?.("rename", "doc.md.tmp");
      await Bun.sleep(120);
      expect(setTimeoutCalls.filter((d) => d === 10).length).toBe(0);
      expect(seen.length).toBe(0);
      resolveInit?.();
      await Bun.sleep(500);
      expect(buildCalls).toBe(1);
      expect(seen.some((batch) => batch.includes("doc.md"))).toBe(true);
      await service.dispose();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      await safeRm(root);
    }
  });

  test("init failure still flips readiness and runs classification fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-init-fail-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      await writeFile(join(root, "final.md"), "x");
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
        store: createStubStore({
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["final.md"],
          }),
          listActiveDirectChildSourcePaths: async () => ({
            ok: true,
            value: ["final.md"],
          }),
        }),
        flushDebounceMs: 20,
        maxFlushDelayMs: 150,
        buildSnapshot: async () => {
          throw new Error("init boom");
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
      watcherCallback?.("change", null);
      await Bun.sleep(600);
      expect(seen.some((batch) => batch.includes("final.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
