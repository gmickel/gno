/** Host review round-4: idle gen, top-level errors, ownership after callbacks. */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  createSyncResult,
  installWatchServiceSyncReset,
} from "./helpers/watch-service-fixtures";

installWatchServiceSyncReset();

const EDGE = {
  relPath: "",
  code: "EDGE_FAIL",
  message: "typed edge projection failed",
} as const;

function coll(name: string, path: string): Collection {
  return { name, path, pattern: "**/*.md", include: [], exclude: [] };
}

function stubStore(overrides: Partial<SqliteAdapter> = {}): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
}

type WatchFactory = typeof import("node:fs").watch;

function fakeWatch(
  setCb: (cb: (e: string, f: string | null) => void) => void
): WatchFactory {
  return ((
    _p: string,
    _o: { recursive: boolean },
    cb: WatchListener<string>
  ) => {
    setCb(cb as (e: string, f: string | null) => void);
    return { close: () => undefined };
  }) as never;
}

function pathWatch(
  map: Map<string, (e: string, f: string) => void>
): WatchFactory {
  return ((
    path: string,
    _o: { recursive: boolean },
    cb: WatchListener<string>
  ) => {
    map.set(path, cb as (e: string, f: string) => void);
    return { close: () => undefined };
  }) as never;
}

function bus(eventUris: string[], schedulerPaths: string[]) {
  return {
    eventBus: {
      emit: (event: { uri: string }) => {
        eventUris.push(event.uri);
      },
    } as never,
    scheduler: {
      notifySyncComplete: (paths: string[]) => {
        schedulerPaths.push(...paths);
      },
    } as never,
  };
}

describe("idle material config/root change", () => {
  test("initial start does not enqueue full syncCollection", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r4-init-"));
    let collectionCalls = 0;
    try {
      await writeFile(join(root, "note.md"), "n");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        return createSyncResult();
      }) as typeof defaultSyncService.syncCollection;
      defaultSyncService.syncPaths = (async () => {
        throw new Error("syncPaths must not run on idle start");
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 100,
        watchFactory: fakeWatch(() => undefined),
      });
      service.start();
      await Bun.sleep(400);
      expect(collectionCalls).toBe(0);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("idle same-root config change enqueues generation reconcile", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r4-idle-cfg-"));
    let collectionCalls = 0;
    const fps: Array<string | undefined> = [];
    try {
      await writeFile(join(root, "note.md"), "n");
      defaultSyncService.syncCollection = (async (_c, _s, options) => {
        collectionCalls += 1;
        fps.push(options?.contentTypeRulesFingerprint);
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "note.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        syncOptions: { contentTypeRulesFingerprint: "v1" },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch(() => undefined),
      });
      service.start();
      await Bun.sleep(80);
      expect(collectionCalls).toBe(0);
      service.updateCollections([coll("notes", root)], {
        contentTypeRulesFingerprint: "v2",
      });
      await Bun.sleep(900);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(fps.at(-1)).toBe("v2");
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("idle root replacement runs syncCollection on new root", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r4-idle-root-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r4-idle-root-b-"));
    let collectionCalls = 0;
    const seenRoots: string[] = [];
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "new.md"), "n");
      defaultSyncService.syncCollection = (async (collection) => {
        collectionCalls += 1;
        seenRoots.push(collection.path);
        return createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
          filesMarkedInactive: 1,
          files: [{ relPath: "new.md", status: "added" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", rootA)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: pathWatch(new Map()),
      });
      service.start();
      await Bun.sleep(80);
      expect(collectionCalls).toBe(0);
      service.updateCollections([coll("notes", rootB)]);
      await Bun.sleep(900);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(seenRoots.some((p) => p === rootB || p.endsWith(rootB))).toBe(
        true
      );
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });
});

describe("top-level errors retain work", () => {
  test("dirty-only success files + EDGE_FAIL retries dirty, withholds snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r4-edge-dirty-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let pathCalls = 0;
    const completePaths: string[] = [];
    const callTimes: number[] = [];
    try {
      await writeFile(join(root, "final.md"), "body");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        pathCalls += 1;
        callTimes.push(Date.now());
        if (pathCalls === 1) {
          return createSyncResult({
            filesProcessed: 1,
            filesUpdated: 1,
            files: [{ relPath: "final.md", status: "updated" }],
            errors: [EDGE],
          });
        }
        expect(relPaths).toContain("final.md");
        return createSyncResult({
          filesProcessed: 1,
          filesUnchanged: 1,
          files: [{ relPath: "final.md", status: "unchanged" }],
          errors: pathCalls < 3 ? [EDGE] : [],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore({
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["final.md"],
          }),
          listActiveDescendantSourcePaths: async () => ({
            ok: true,
            value: ["final.md"],
          }),
        }),
        callbacks: {
          onSyncComplete: (event) => {
            completePaths.push(...event.relPaths);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      cb?.("change", null);
      await Bun.sleep(1_800);
      expect(pathCalls).toBeGreaterThanOrEqual(3);
      expect(pathCalls).toBeLessThanOrEqual(6);
      // onSyncComplete once per completed attempt; content success settles once
      // via first updated receipt (afterSync/scheduler), not path-count=1.
      expect(completePaths.filter((p) => p === "final.md").length).toBe(
        pathCalls
      );
      if (callTimes.length >= 2) {
        expect(
          (callTimes[1] ?? 0) - (callTimes[0] ?? 0)
        ).toBeGreaterThanOrEqual(400);
      }
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("generation success files + EDGE_FAIL keeps durable retry", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r4-edge-gen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r4-edge-gen-b-"));
    let collectionCalls = 0;
    const completeCalls: number[] = [];
    const schedulerPaths: string[] = [];
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "ok.md"), "ok");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls === 1) {
          return createSyncResult({
            filesProcessed: 1,
            filesUpdated: 1,
            files: [{ relPath: "ok.md", status: "updated" }],
            errors: [EDGE],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUnchanged: 1,
          files: [{ relPath: "ok.md", status: "unchanged" }],
          errors: collectionCalls < 3 ? [EDGE] : [],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", rootA)],
        eventBus: null,
        scheduler: {
          notifySyncComplete: (paths: string[]) => {
            schedulerPaths.push(...paths);
          },
        } as never,
        store: stubStore(),
        callbacks: {
          onSyncComplete: () => {
            completeCalls.push(1);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: pathWatch(new Map()),
      });
      service.start();
      await Bun.sleep(60);
      service.updateCollections([coll("notes", rootB)]);
      await Bun.sleep(1_800);
      expect(collectionCalls).toBeGreaterThanOrEqual(3);
      expect(collectionCalls).toBeLessThanOrEqual(6);
      // One onSyncComplete per completed attempt; scheduler only on updated.
      expect(completeCalls.length).toBe(collectionCalls);
      expect(schedulerPaths.filter((p) => p === "ok.md").length).toBe(1);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });
});

describe("ownership after onSyncComplete callbacks", () => {
  test("targeted partial onSyncComplete root change skips old-owner afterSync", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r4-own-tgt-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r4-own-tgt-b-"));
    let cb: ((e: string, f: string) => void) | undefined;
    let service: CollectionWatchService | undefined;
    const schedulerPaths: string[] = [];
    const eventUris: string[] = [];
    try {
      await writeFile(join(rootA, "a.md"), "a");
      await writeFile(join(rootA, "b.md"), "b");
      await writeFile(join(rootB, "x.md"), "x");
      defaultSyncService.syncPaths = (async () =>
        createSyncResult({
          filesProcessed: 2,
          filesUpdated: 1,
          filesErrored: 1,
          files: [
            { relPath: "a.md", status: "updated" },
            { relPath: "b.md", status: "error", errorCode: "FAIL" },
          ],
        })) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () =>
        createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
          files: [{ relPath: "x.md", status: "added" }],
        })) as typeof defaultSyncService.syncCollection;

      service = new CollectionWatchService({
        collections: [coll("notes", rootA)],
        ...bus(eventUris, schedulerPaths),
        store: stubStore(),
        callbacks: {
          onSyncComplete: () => {
            service?.updateCollections([coll("notes", rootB)]);
          },
        },
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: fakeWatch((c) => {
          cb = c as (e: string, f: string) => void;
        }),
      });
      service.start();
      await Bun.sleep(40);
      cb?.("change", "a.md");
      cb?.("change", "b.md");
      await Bun.sleep(1_200);
      expect(schedulerPaths).not.toContain("a.md");
      expect(eventUris.some((u) => u.includes("a.md"))).toBe(false);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });

  test("generation partial onSyncComplete root change skips old-owner afterSync", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r4-own-gen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r4-own-gen-b-"));
    const rootC = await mkdtemp(join(tmpdir(), "gno-watch-r4-own-gen-c-"));
    let service: CollectionWatchService | undefined;
    const schedulerPaths: string[] = [];
    const eventUris: string[] = [];
    let collectionCalls = 0;
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "ok.md"), "ok");
      await writeFile(join(rootC, "next.md"), "n");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls === 1) {
          return createSyncResult({
            filesProcessed: 1,
            filesUpdated: 1,
            filesErrored: 1,
            files: [
              { relPath: "ok.md", status: "updated" },
              { relPath: "bad.md", status: "error", errorCode: "FAIL" },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
          files: [{ relPath: "next.md", status: "added" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      service = new CollectionWatchService({
        collections: [coll("notes", rootA)],
        ...bus(eventUris, schedulerPaths),
        store: stubStore(),
        callbacks: {
          onSyncComplete: (event) => {
            if (event.relPaths.includes("ok.md")) {
              service?.updateCollections([coll("notes", rootC)]);
            }
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: pathWatch(new Map()),
      });
      service.start();
      await Bun.sleep(60);
      service.updateCollections([coll("notes", rootB)]);
      await Bun.sleep(1_400);
      expect(schedulerPaths).not.toContain("ok.md");
      expect(eventUris.some((u) => u.includes("ok.md"))).toBe(false);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
      await safeRm(rootC);
    }
  });
});
