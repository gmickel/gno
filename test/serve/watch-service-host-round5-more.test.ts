/** Host review round-5 (cont): exact top-level errors + callback contract. */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
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

describe("exact-only top-level error authority", () => {
  test("all file receipts success + EDGE_FAIL requeues exact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-exact-edge-"));
    let cb: ((e: string, f: string) => void) | undefined;
    let pathCalls = 0;
    const batches: string[][] = [];
    const completeResults: CollectionSyncResult[] = [];
    try {
      await writeFile(join(root, "note.md"), "n");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        pathCalls += 1;
        batches.push([...relPaths]);
        if (pathCalls < 3) {
          return createSyncResult({
            filesProcessed: 1,
            filesUpdated: pathCalls === 1 ? 1 : 0,
            filesUnchanged: pathCalls === 1 ? 0 : 1,
            files: [
              {
                relPath: "note.md",
                status: pathCalls === 1 ? "updated" : "unchanged",
              },
            ],
            errors: [EDGE],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUnchanged: 1,
          files: [{ relPath: "note.md", status: "unchanged" }],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        callbacks: {
          onSyncComplete: (_event) => {
            completeResults.push(_event.result);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c as (e: string, f: string) => void;
        }),
      });
      service.start();
      await Bun.sleep(60);
      cb?.("change", "note.md");
      await Bun.sleep(1_800);
      expect(pathCalls).toBeGreaterThanOrEqual(3);
      expect(pathCalls).toBeLessThanOrEqual(6);
      expect(batches.every((b) => b.includes("note.md"))).toBe(true);
      expect(completeResults.length).toBe(pathCalls);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("mixed file error + top-level error retries failed and retains exact", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-mixed-edge-"));
    let cb: ((e: string, f: string) => void) | undefined;
    let pathCalls = 0;
    const schedulerPaths: string[] = [];
    try {
      await writeFile(join(root, "a.md"), "a");
      await writeFile(join(root, "b.md"), "b");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        pathCalls += 1;
        if (pathCalls === 1) {
          return createSyncResult({
            filesProcessed: 2,
            filesUpdated: 1,
            filesErrored: 1,
            files: [
              { relPath: "a.md", status: "updated" },
              { relPath: "b.md", status: "error", errorCode: "FAIL" },
            ],
            errors: [EDGE],
          });
        }
        expect(relPaths).toContain("b.md");
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.includes("b.md") ? 1 : 0,
          filesUnchanged: relPaths.includes("a.md") ? 1 : 0,
          files: relPaths.map((relPath) => ({
            relPath,
            status:
              relPath === "b.md"
                ? ("updated" as const)
                : ("unchanged" as const),
          })),
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: {
          notifySyncComplete: (paths: string[]) => {
            schedulerPaths.push(...paths);
          },
        } as never,
        store: stubStore(),
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
      await Bun.sleep(1_400);
      expect(pathCalls).toBeGreaterThanOrEqual(2);
      expect(schedulerPaths.filter((p) => p === "a.md").length).toBe(1);
      expect(schedulerPaths).toContain("b.md");
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("callback contract", () => {
  test("unchanged targeted sync still fires onSyncComplete once", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-unch-"));
    let cb: ((e: string, f: string) => void) | undefined;
    let complete = 0;
    const schedulerPaths: string[] = [];
    try {
      await writeFile(join(root, "note.md"), "n");
      defaultSyncService.syncPaths = (async () =>
        createSyncResult({
          filesProcessed: 1,
          filesUnchanged: 1,
          files: [{ relPath: "note.md", status: "unchanged" }],
        })) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: {
          notifySyncComplete: (paths: string[]) => {
            schedulerPaths.push(...paths);
          },
        } as never,
        store: stubStore(),
        callbacks: {
          onSyncComplete: (event) => {
            complete += 1;
            expect(event.relPaths).toContain("note.md");
            expect(event.result.filesUnchanged).toBe(1);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c as (e: string, f: string) => void;
        }),
      });
      service.start();
      await Bun.sleep(50);
      cb?.("change", "note.md");
      await Bun.sleep(500);
      expect(complete).toBe(1);
      expect(schedulerPaths).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("inactive-only generation fires onSyncComplete without scheduler paths", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r5-inact-gen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r5-inact-gen-b-"));
    let complete = 0;
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "keep.md"), "k");
      defaultSyncService.syncCollection = (async () =>
        createSyncResult({
          filesProcessed: 1,
          filesMarkedInactive: 1,
          filesUnchanged: 0,
          files: [{ relPath: "gone.md", status: "updated" }],
        })) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", rootA)],
        eventBus: null,
        scheduler: {
          notifySyncComplete: () => undefined,
        } as never,
        store: stubStore(),
        callbacks: {
          onSyncComplete: (event) => {
            complete += 1;
            expect(event.result.filesMarkedInactive).toBe(1);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: ((
          path: string,
          _o: { recursive: boolean },
          _cb: WatchListener<string>
        ) => {
          void path;
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      await Bun.sleep(60);
      service.updateCollections([coll("notes", rootB)]);
      await Bun.sleep(900);
      expect(complete).toBeGreaterThanOrEqual(1);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });

  test("partial error still fires onSyncComplete with operation scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-partial-cb-"));
    let cb: ((e: string, f: string) => void) | undefined;
    const completeScopes: string[][] = [];
    try {
      await writeFile(join(root, "a.md"), "a");
      await writeFile(join(root, "b.md"), "b");
      let attempts = 0;
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        attempts += 1;
        if (attempts === 1) {
          return createSyncResult({
            filesProcessed: 2,
            filesUpdated: 1,
            filesErrored: 1,
            files: [
              { relPath: "a.md", status: "updated" },
              { relPath: "b.md", status: "error", errorCode: "FAIL" },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: 1,
          files: relPaths.map((relPath) => ({
            relPath,
            status: "updated" as const,
          })),
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        callbacks: {
          onSyncComplete: (event) => {
            completeScopes.push([...event.relPaths]);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c as (e: string, f: string) => void;
        }),
      });
      service.start();
      await Bun.sleep(40);
      cb?.("change", "a.md");
      cb?.("change", "b.md");
      await Bun.sleep(1_200);
      expect(completeScopes.length).toBeGreaterThanOrEqual(2);
      expect(completeScopes[0]?.includes("a.md")).toBe(true);
      expect(completeScopes[0]?.includes("b.md")).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
