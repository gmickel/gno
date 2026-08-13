/** Host review round-3: unsupported-FS, multi-gen, config+dirty, partial success. */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises"; // test fixture setup
import { tmpdir } from "node:os";
import { join } from "node:path"; // Bun has no path utilities

import type { WatcherSnapshotFs } from "../../src/serve/watch-snapshot";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  createCollection,
  createStubStore,
  createSyncResult,
  installWatchServiceSyncReset,
} from "./helpers/watch-service-fixtures";

installWatchServiceSyncReset();

function unsupportedFs(pathOps: string[]): WatcherSnapshotFs {
  const boom = async (label: string): Promise<never> => {
    pathOps.push(label);
    throw new Error(`should not ${label}`);
  };
  return {
    supportsAnchoredHandles: false,
    openDir: async (abs) => boom(`open:${abs}`),
    readDir: async () => boom("readDir"),
    lstatChild: async (_h, name) => boom(`lstat:${name}`),
    openChildDir: async (_h, name) => boom(`openChild:${name}`),
    closeDir: async () => undefined,
  };
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

describe("unsupported FS ambiguous → full reconcile", () => {
  test("ambiguous event invokes syncCollection, settles, no path ops", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r3-unsup-ok-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    const pathOps: string[] = [];
    let collectionCalls = 0;
    const completePaths: string[][] = [];
    try {
      await writeFile(join(root, "final.md"), "x");
      defaultSyncService.syncPaths = (async () => {
        throw new Error("syncPaths must not run for unsupported dirty-only");
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "final.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        snapshotFs: unsupportedFs(pathOps),
        buildSnapshot: async () => ({
          status: "fallback",
          reason: "scan_failed",
          durationMs: 0,
          cause: new Error("unsupported"),
        }),
        callbacks: {
          onSyncComplete: (event) => {
            completePaths.push(event.relPaths);
          },
        },
        flushDebounceMs: 20,
        maxFlushDelayMs: 150,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      cb?.("rename", "final.md.tmp");
      await Bun.sleep(700);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(completePaths.some((p) => p.includes("final.md"))).toBe(true);
      expect(pathOps).toEqual([]);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("full reconcile failure retries bounded without path ops", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r3-unsup-fail-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    const pathOps: string[] = [];
    let collectionCalls = 0;
    const callTimes: number[] = [];
    try {
      await writeFile(join(root, "doc.md"), "x");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        callTimes.push(Date.now());
        if (collectionCalls < 3) {
          throw new Error("full reconcile boom");
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "doc.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        snapshotFs: unsupportedFs(pathOps),
        buildSnapshot: async () => ({
          status: "fallback",
          reason: "scan_failed",
          durationMs: 0,
          cause: new Error("unsupported"),
        }),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      cb?.("change", null);
      await Bun.sleep(1_600);
      expect(collectionCalls).toBeGreaterThanOrEqual(3);
      expect(collectionCalls).toBeLessThanOrEqual(5);
      if (callTimes.length >= 2) {
        expect(
          (callTimes[1] ?? 0) - (callTimes[0] ?? 0)
        ).toBeGreaterThanOrEqual(400);
      }
      expect(pathOps).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("second generation during full sync", () => {
  test("blocked syncCollection then second update reconciles latest options", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r3-multigen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r3-multigen-b-"));
    const rootC = await mkdtemp(join(tmpdir(), "gno-watch-r3-multigen-c-"));
    const callbacks = new Map<string, (e: string, f: string) => void>();
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const seenFingerprints: Array<string | undefined> = [];
    let pathCalls = 0;
    let collectionCalls = 0;
    try {
      await writeFile(join(rootA, "note.md"), "n");
      await writeFile(join(rootB, "note.md"), "n");
      await writeFile(join(rootC, "note.md"), "n");
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        if (pathCalls === 1) {
          await firstGate;
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "note.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async (_c, _s, options) => {
        collectionCalls += 1;
        seenFingerprints.push(options?.contentTypeRulesFingerprint);
        if (collectionCalls === 1) {
          await firstGate;
          return createSyncResult({
            filesProcessed: 1,
            filesUpdated: 1,
            files: [{ relPath: "note.md", status: "updated" }],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "note.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", rootA)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        syncOptions: { contentTypeRulesFingerprint: "gen-a" },
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: pathWatch(callbacks),
      });
      service.start();
      await Bun.sleep(40);
      callbacks.get(rootA)?.("change", "note.md");
      await Bun.sleep(150);
      service.updateCollections([createCollection("notes", rootB)], {
        contentTypeRulesFingerprint: "gen-b",
      });
      await Bun.sleep(100);
      service.updateCollections([createCollection("notes", rootC)], {
        contentTypeRulesFingerprint: "gen-c",
      });
      finishFirst?.();
      await Bun.sleep(1_000);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(seenFingerprints.at(-1)).toBe("gen-c");
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
      await safeRm(rootC);
    }
  });
});

describe("same-root config change with queued ambiguous work", () => {
  test("temp event then config update still reaches final via full reconcile", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r3-cfg-dirty-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    const pathBatches: string[][] = [];
    let collectionCalls = 0;
    try {
      await writeFile(join(root, "doc.md"), "final-body");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        pathBatches.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
          files: relPaths.map((relPath) => ({
            relPath,
            status: "updated" as const,
          })),
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "doc.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore({
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["doc.md"],
          }),
          listActiveDirectChildSourcePaths: async () => ({
            ok: true,
            value: ["doc.md"],
          }),
        }),
        syncOptions: { contentTypeRulesFingerprint: "before" },
        flushDebounceMs: 80,
        maxFlushDelayMs: 400,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(60);
      cb?.("rename", "doc.md.tmp");
      await Bun.sleep(20);
      service.updateCollections(
        [createCollection("notes", root, { exclude: ["**/skip/**"] })],
        { contentTypeRulesFingerprint: "after" }
      );
      await Bun.sleep(900);
      expect(
        pathBatches.some((batch) => batch.includes("doc.md")) ||
          collectionCalls >= 1
      ).toBe(true);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("partial success settlement", () => {
  test("two-path mixed syncPaths notifies A once and retries B", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r3-partial-paths-"));
    let cb: ((e: string, f: string) => void) | undefined;
    let attempts = 0;
    const completeA: string[] = [];
    try {
      await writeFile(join(root, "a.md"), "a");
      await writeFile(join(root, "b.md"), "b");
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
        expect(relPaths).toContain("b.md");
        expect(relPaths).not.toContain("a.md");
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "b.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        callbacks: {
          onSyncComplete: (event) => {
            completeA.push(...event.relPaths);
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
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(completeA.filter((p) => p === "a.md").length).toBe(1);
      expect(completeA).toContain("b.md");
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("generation mixed result notifies success once and retries", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-r3-partial-gen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-r3-partial-gen-b-"));
    const callbacks = new Map<string, (e: string, f: string) => void>();
    let pathCalls = 0;
    let collectionCalls = 0;
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const completeCalls: number[] = [];
    const schedulerPaths: string[] = [];
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "ok.md"), "ok");
      await writeFile(join(rootB, "bad.md"), "bad");
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        if (pathCalls === 1) {
          await firstGate;
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "old.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls === 1) {
          return createSyncResult({
            filesProcessed: 2,
            filesUpdated: 1,
            filesErrored: 1,
            files: [
              { relPath: "ok.md", status: "updated" },
              { relPath: "bad.md", status: "error", errorCode: "FAIL" },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: 2,
          filesUpdated: 1,
          filesUnchanged: 1,
          files: [
            { relPath: "ok.md", status: "unchanged" },
            { relPath: "bad.md", status: "updated" },
          ],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", rootA)],
        eventBus: null,
        scheduler: {
          notifySyncComplete: (paths: string[]) => {
            schedulerPaths.push(...paths);
          },
        } as never,
        store: createStubStore(),
        callbacks: {
          onSyncComplete: () => {
            completeCalls.push(1);
          },
        },
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: pathWatch(callbacks),
      });
      service.start();
      await Bun.sleep(40);
      callbacks.get(rootA)?.("change", "old.md");
      await Bun.sleep(150);
      service.updateCollections([createCollection("notes", rootB)]);
      finishFirst?.();
      await Bun.sleep(1_200);
      expect(collectionCalls).toBeGreaterThanOrEqual(2);
      // onSyncComplete once per completed gen attempt; scheduler settles content once.
      expect(completeCalls.length).toBeGreaterThanOrEqual(2);
      expect(schedulerPaths.filter((p) => p === "ok.md").length).toBe(1);
      expect(schedulerPaths).toContain("bad.md");
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });
});
