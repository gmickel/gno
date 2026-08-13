/** Real-filesystem end-state proofs for watcher reconciliation. */

import type { WatchListener } from "node:fs";

import { describe, expect, test } from "bun:test";
// node:fs/promises — structural fixture operations have no Bun equivalent.
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
// node:os — Bun has no temp-directory helper.
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities.
import { join } from "node:path";

import type { WatcherSnapshotFs } from "../../src/serve/watch-snapshot";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { buildWatcherSnapshot } from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";
import {
  createCollection,
  createSyncResult,
  createStubStore,
  installWatchServiceSyncReset,
} from "./helpers/watch-service-fixtures";
import { statefulInactiveStore } from "./helpers/watch-service-round6-fixtures";
import { createRealPathBackedWatcherFs } from "./helpers/watch-snapshot-fixtures";

installWatchServiceSyncReset();

type WatchCallback = (event: string, filename: string | null) => void;

function capturingWatch(setCallback: (callback: WatchCallback) => void) {
  return ((
    _path: string,
    _options: { recursive: boolean },
    callback: WatchListener<string>
  ) => {
    setCallback(callback as WatchCallback);
    return { close: () => undefined };
  }) as never;
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await Bun.sleep(10);
  }
}

async function baseline(root: string, fs: WatcherSnapshotFs) {
  // This suite proves cross-platform service end states over real files. Use
  // the test-only adapter so Windows exercises snapshot classification without
  // weakening production's deliberate unsupported-handle -> full-sync path.
  const built = await buildWatcherSnapshot(root, {
    fs,
  });
  if (built.status !== "ok") {
    throw new Error(`Unable to build fixture baseline: ${built.status}`);
  }
  return built;
}

async function startFixture(options: {
  root: string;
  store?: SqliteAdapter;
  onError?: (error: unknown) => void;
}) {
  let callback: WatchCallback | undefined;
  const snapshotFs = createRealPathBackedWatcherFs();
  const built = await baseline(options.root, snapshotFs);
  const service = new CollectionWatchService({
    collections: [createCollection("notes", options.root)],
    eventBus: null,
    scheduler: null,
    store: options.store ?? createStubStore(),
    flushDebounceMs: 5,
    maxFlushDelayMs: 50,
    snapshotFs,
    buildSnapshot: async () => built,
    watchFactory: capturingWatch((value) => {
      callback = value;
    }),
    callbacks: {
      onSyncError: ({ error }) => options.onError?.(error),
    },
  });
  service.start();
  await Promise.resolve();
  await waitUntil(() => callback !== undefined, "watch callback");
  return {
    service,
    emit: (filename: string | null) => callback?.("rename", filename),
  };
}

describe("CollectionWatchService real filesystem", () => {
  test("exact same-size edit with restored mtime still reaches content hashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-fs-exact-"));
    const path = join(root, "exact.md");
    const batches: string[][] = [];
    try {
      await writeFile(path, "alpha");
      const original = Bun.file(path).lastModified;
      defaultSyncService.syncPaths = (async (
        _collection: unknown,
        _store: unknown,
        paths: string[]
      ) => {
        batches.push(paths);
        return createSyncResult({
          filesProcessed: paths.length,
          filesUpdated: paths.length,
          files: paths.map((relPath) => ({ relPath, status: "updated" })),
        });
      }) as never;
      const fixture = await startFixture({ root });
      await writeFile(path, "bravo");
      const restored = new Date(original);
      await utimes(path, restored, restored);
      fixture.emit("exact.md");
      await waitUntil(() => batches.length === 1, "exact synchronization");
      expect(batches).toEqual([["exact.md"]]);
      await fixture.service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("plain and dot temp atomic replacement select only the final target", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-fs-atomic-"));
    const target = join(root, "note.md");
    const batches: string[][] = [];
    try {
      await writeFile(target, "before");
      await writeFile(join(root, "sibling.md"), "untouched");
      defaultSyncService.syncPaths = (async (
        _collection: unknown,
        _store: unknown,
        paths: string[]
      ) => {
        batches.push(paths);
        return createSyncResult({
          filesProcessed: paths.length,
          filesUpdated: paths.length,
          files: paths.map((relPath) => ({ relPath, status: "updated" })),
        });
      }) as never;
      defaultSyncService.syncCollection = (async () => {
        batches.push(["note.md"]);
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "note.md", status: "updated" }],
        });
      }) as never;
      const fixture = await startFixture({ root });

      await writeFile(join(root, "note.md.tmp"), "plain-temp");
      await rename(join(root, "note.md.tmp"), target);
      fixture.emit("note.md.tmp");
      await waitUntil(() => batches.length === 1, "plain temp replacement");

      await writeFile(join(root, ".note.md.tmp"), "dot-temp");
      await rename(join(root, ".note.md.tmp"), target);
      fixture.emit(".note.md.tmp");
      await waitUntil(() => batches.length === 2, "dot temp replacement");

      expect(batches).toEqual([["note.md"], ["note.md"]]);
      expect(batches.flat()).not.toContain("sibling.md");
      await fixture.service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("recursive deletion inactivates descendants and a new directory indexes its file", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-fs-tree-"));
    const { store, inactive, docs } = statefulInactiveStore([
      "old/a.md",
      "old/deep/b.md",
      "sibling.md",
    ]);
    const synced: string[][] = [];
    try {
      await mkdir(join(root, "old", "deep"), { recursive: true });
      await writeFile(join(root, "old", "a.md"), "a");
      await writeFile(join(root, "old", "deep", "b.md"), "b");
      await writeFile(join(root, "sibling.md"), "sibling");
      defaultSyncService.syncPaths = (async (
        _collection: unknown,
        _store: unknown,
        paths: string[]
      ) => {
        synced.push(paths);
        return createSyncResult({
          filesProcessed: paths.length,
          filesAdded: paths.length,
          files: paths.map((relPath) => ({ relPath, status: "added" })),
        });
      }) as never;
      defaultSyncService.syncCollection = (async () => {
        if (!(await Bun.file(join(root, "old", "a.md")).exists())) {
          for (const path of ["old/a.md", "old/deep/b.md"]) {
            const row = docs.get(path);
            if (row?.active) {
              row.active = false;
              inactive.push(path);
            }
          }
        }
        if (await Bun.file(join(root, "new", "deep", "fresh.md")).exists()) {
          synced.push(["new/deep/fresh.md"]);
        }
        return createSyncResult();
      }) as never;
      const fixture = await startFixture({ root, store });

      await rm(join(root, "old"), { recursive: true });
      fixture.emit("old");
      await waitUntil(() => inactive.length === 2, "recursive inactivation");
      expect(inactive.sort()).toEqual(["old/a.md", "old/deep/b.md"]);
      expect(docs.get("sibling.md")?.active).toBe(true);

      await mkdir(join(root, "new", "deep"), { recursive: true });
      await writeFile(join(root, "new", "deep", "fresh.md"), "fresh");
      fixture.emit("new");
      await waitUntil(
        () => synced.length === 1,
        "new directory synchronization"
      );
      expect(synced).toEqual([["new/deep/fresh.md"]]);
      await fixture.service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("symlink replacement stays exact; root loss errors then recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-fs-link-"));
    const targetA = join(root, "target-a.txt");
    const targetB = join(root, "target-b.txt");
    const link = join(root, "link.md");
    const batches: string[][] = [];
    const errors: unknown[] = [];
    try {
      await writeFile(targetA, "a");
      await writeFile(targetB, "b");
      try {
        await symlink(targetA, link);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        if (process.platform === "win32" && code === "EPERM") {
          console.warn("watcher symlink capability unavailable: EPERM");
          return;
        }
        throw error;
      }
      defaultSyncService.syncPaths = (async (
        _collection: unknown,
        _store: unknown,
        paths: string[]
      ) => {
        batches.push(paths);
        return createSyncResult({
          filesProcessed: paths.length,
          filesUpdated: paths.length,
          files: paths.map((relPath) => ({ relPath, status: "updated" })),
        });
      }) as never;
      defaultSyncService.syncCollection = (async () => {
        if (!(await Bun.file(root).exists())) {
          return createSyncResult({
            filesErrored: 1,
            errors: [
              { relPath: "", code: "ROOT_MISSING", message: "root missing" },
            ],
          });
        }
        if (await Bun.file(join(root, "recovered.md")).exists()) {
          batches.push(["recovered.md"]);
        }
        return createSyncResult();
      }) as never;
      defaultSyncService.inactivateAbsentSources = (async (
        _collection: unknown,
        _store: unknown,
        paths: string[]
      ) =>
        createSyncResult({
          filesProcessed: paths.length,
          filesUpdated: paths.length,
          filesMarkedInactive: paths.length,
          files: paths.map((relPath) => ({ relPath, status: "updated" })),
        })) as never;
      const fixture = await startFixture({
        root,
        onError: (error) => errors.push(error),
      });
      await unlink(link);
      await symlink(targetB, link);
      fixture.emit("link.md");
      await waitUntil(() => batches.length === 1, "symlink replacement");
      expect(batches).toEqual([["link.md"]]);

      await rm(root, { recursive: true });
      fixture.emit(null);
      await waitUntil(() => errors.length > 0, "root-loss error");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "recovered.md"), "recovered");
      fixture.emit(null);
      await waitUntil(
        () => batches.some((batch) => batch.includes("recovered.md")),
        "root recovery"
      );
      await fixture.service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
