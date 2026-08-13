/** Host review round-5: proven removals + overflow→full sync. */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";
import type { DocumentRow } from "../../src/store/types";

import { defaultSyncService } from "../../src/ingestion";
import {
  classifyDirtyHints,
  WATCHER_FALLBACK_BUDGET,
} from "../../src/serve/watch-reconciliation";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  createSyncResult,
  installWatchServiceSyncReset,
} from "./helpers/watch-service-fixtures";

installWatchServiceSyncReset();

const originalInactivate =
  defaultSyncService.inactivateAbsentSources.bind(defaultSyncService);

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

/** Stateful store stub for proven-removal inactivation proofs. */
function statefulInactiveStore(activePaths: string[]): {
  store: SqliteAdapter;
  inactive: string[];
  docs: Map<string, { active: boolean; id: number; docid: string }>;
} {
  const inactive: string[] = [];
  const docs = new Map(
    activePaths.map((relPath, i) => [
      relPath,
      { active: true, id: i + 1, docid: `doc-${i + 1}` },
    ])
  );
  const store = {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async (
      _c: string,
      dir: string,
      _max: number
    ) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const value = [...docs.keys()].filter(
        (p) =>
          docs.get(p)?.active &&
          (dir === "" ? true : p === dir || p.startsWith(prefix))
      );
      return { ok: true as const, value };
    },
    listActiveSourcePaths: async () => ({
      ok: true as const,
      value: [...docs.entries()].filter(([, d]) => d.active).map(([p]) => p),
    }),
    listRecordDocuments: async () => ({ ok: true as const, value: [] }),
    getDocument: async (_c: string, relPath: string) => {
      const row = docs.get(relPath);
      if (!row) {
        return { ok: true as const, value: null };
      }
      return {
        ok: true as const,
        value: {
          id: row.id,
          docid: row.docid,
          collection: "notes",
          relPath,
          active: row.active,
        } as DocumentRow,
      };
    },
    markInactive: async (_c: string, relPaths: string[]) => {
      let count = 0;
      for (const p of relPaths) {
        const row = docs.get(p);
        if (row?.active) {
          row.active = false;
          inactive.push(p);
          count += 1;
        }
      }
      return { ok: true as const, value: count };
    },
    getBacklinksForDoc: async () => ({ ok: true as const, value: [] }),
    getEdgeBacklinksForDoc: async () => ({ ok: true as const, value: [] }),
  } as unknown as SqliteAdapter;
  return { store, inactive, docs };
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

describe("proven removal authority", () => {
  test("file→directory: inactivate old file; children reach syncPaths separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-f2d-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    const syncBatches: string[][] = [];
    const inactiveBatches: string[][] = [];
    try {
      await writeFile(join(root, "slot.md"), "was-file");
      // Baseline snapshot while still a file.
      const serviceBoot = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 100,
        watchFactory: fakeWatch(() => undefined),
      });
      serviceBoot.start();
      await Bun.sleep(200);
      await serviceBoot.dispose();

      await safeRm(join(root, "slot.md"));
      await mkdir(join(root, "slot.md"), { recursive: true });
      await writeFile(join(root, "slot.md", "child.md"), "child");

      const { store, inactive } = statefulInactiveStore(["slot.md"]);
      defaultSyncService.inactivateAbsentSources = (async (
        _c,
        _s,
        relPaths
      ) => {
        inactiveBatches.push([...relPaths]);
        // Delegate to real method against stateful store.
        return originalInactivate(_c, store, relPaths);
      }) as typeof defaultSyncService.inactivateAbsentSources;
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        syncBatches.push([...relPaths]);
        expect(relPaths).not.toContain("slot.md");
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesAdded: relPaths.includes("slot.md/child.md") ? 1 : 0,
          files: relPaths.map((relPath) => ({
            relPath,
            status: "added" as const,
          })),
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store,
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(150);
      // Force fallback so store sees slot.md as removal vs disk dir children.
      cb?.("rename", "slot.md");
      await Bun.sleep(900);
      expect(inactiveBatches.some((b) => b.includes("slot.md"))).toBe(true);
      expect(inactive).toContain("slot.md");
      expect(syncBatches.some((b) => b.includes("slot.md/child.md"))).toBe(
        true
      );
      expect(syncBatches.every((b) => !b.includes("slot.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("file→FIFO/device: inactivate old file; special is not a candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-fifo-"));
    try {
      await writeFile(join(root, "keep.md"), "k");
      // Store reports gone.md active; disk has no file (simulate special/missing).
      const classified = await classifyDirtyHints({
        collection: coll("notes", root),
        store: stubStore({
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["keep.md", "special.md"],
          }),
          listActiveDescendantSourcePaths: async () => ({
            ok: true,
            value: ["keep.md", "special.md"],
          }),
        }),
        rootAbs: root,
        previous: null,
        dirtyHints: [""],
        forceFallback: true,
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.candidates).toContain("keep.md");
      expect(classified.candidates).not.toContain("special.md");
      expect(classified.removals).toContain("special.md");
    } finally {
      await safeRm(root);
    }
  });

  test("inactivateAbsentSources marks active docs without requiring disk absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-inact-"));
    try {
      // Path now a directory — syncPaths would NOT_FILE; inactivation still works.
      await mkdir(join(root, "was-file.md"), { recursive: true });
      const { store, inactive } = statefulInactiveStore(["was-file.md"]);
      const result = await defaultSyncService.inactivateAbsentSources(
        coll("notes", root),
        store,
        ["was-file.md"],
        { projectTypedEdges: false }
      );
      expect(result.filesMarkedInactive).toBe(1);
      expect(result.filesErrored).toBe(0);
      expect(inactive).toEqual(["was-file.md"]);
      expect(result.files?.[0]?.status).toBe("updated");
    } finally {
      await safeRm(root);
    }
  });
});

describe("overflow progression to full sync", () => {
  test("fallback budget overflow escalates to syncCollection (not infinite dirty)", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-budg-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let collectionCalls = 0;
    let pathCalls = 0;
    const many = Array.from(
      { length: WATCHER_FALLBACK_BUDGET + 64 },
      (_, i) => `n${String(i).padStart(5, "0")}.md`
    );
    try {
      await writeFile(join(root, "seed.md"), "s");
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        return createSyncResult();
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "seed.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore({
          listActiveSourcePaths: async () => ({ ok: true, value: many }),
          listActiveDescendantSourcePaths: async () => ({
            ok: true,
            value: many,
          }),
        }),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      cb?.("change", null);
      await Bun.sleep(1_200);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(collectionCalls).toBeLessThanOrEqual(4);
      // Must not thrash identical dirty classification via syncPaths only.
      expect(pathCalls).toBeLessThanOrEqual(2);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("injected snapshot ceiling overflow escalates to full sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r5-snap-ov-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let collectionCalls = 0;
    let pathCalls = 0;
    try {
      await writeFile(join(root, "a.md"), "a");
      await writeFile(join(root, "b.md"), "b");
      const { buildWatcherSnapshot } =
        await import("../../src/serve/watch-snapshot");
      const built = await buildWatcherSnapshot(root);
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        throw new Error("baseline required");
      }
      // Direct classification proof.
      const classified = await classifyDirtyHints({
        collection: coll("notes", root),
        store: stubStore(),
        rootAbs: root,
        previous: built.snapshot,
        dirtyHints: [""],
        snapshotOptions: { entryCeiling: 0 },
      });
      expect(classified.status).toBe("full_reconcile");
      if (classified.status === "full_reconcile") {
        expect(classified.reason).toBe("snapshot_overflow");
      }

      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "a.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        return createSyncResult();
      }) as typeof defaultSyncService.syncPaths;

      // Service: real baseline, then entryCeiling 0 forces snapshot overflow→full.
      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        snapshotEntryCeiling: 0,
        buildSnapshot: async () => ({
          status: "ok",
          snapshot: built.snapshot,
          durationMs: 1,
        }),
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(150);
      cb?.("change", null);
      await Bun.sleep(1_200);
      expect(collectionCalls).toBeGreaterThanOrEqual(1);
      expect(collectionCalls).toBeLessThanOrEqual(4);
      expect(pathCalls).toBeLessThanOrEqual(1);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
