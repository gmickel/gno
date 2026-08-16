/**
 * Scale/linearity regressions for watcher hierarchical snapshots (gno-27 task .1).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SnapshotEntryFingerprint,
  WatcherDirHandle,
  WatcherSnapshotFs,
} from "../../src/serve/watch-snapshot";

import {
  WATCHER_SNAPSHOT_ENTRY_CEILING,
  buildWatcherSnapshot,
  diffWatcherSnapshot,
  removeSubtreeFromMaps,
} from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";
import {
  createRealPathBackedWatcherFs,
  snapshotFingerprint,
  writeWatchFixture,
} from "./helpers/watch-snapshot-fixtures";

describe("watcher snapshot scale", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-snap-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("many-directory scans stay linear in handle operations", async () => {
    const dirCount = 2_500;
    type Node =
      | { kind: "dir"; children: Map<string, Node>; dev: bigint; ino: bigint }
      | {
          kind: "file";
          size: number;
          dev: bigint;
          ino: bigint;
          mtimeNs: bigint;
          ctimeNs: bigint;
        };

    let nextIno = 1n;
    const rootNode: Extract<Node, { kind: "dir" }> = {
      kind: "dir",
      children: new Map(),
      dev: 1n,
      ino: nextIno,
    };
    nextIno += 1n;

    for (let i = 0; i < dirCount; i += 1) {
      const name = `d${String(i).padStart(4, "0")}`;
      const dir: Extract<Node, { kind: "dir" }> = {
        kind: "dir",
        children: new Map(),
        dev: 1n,
        ino: nextIno,
      };
      nextIno += 1n;
      dir.children.set("f.md", {
        kind: "file",
        size: 1,
        dev: 1n,
        ino: nextIno,
        mtimeNs: 1_000n,
        ctimeNs: 1_000n,
      });
      nextIno += 1n;
      rootNode.children.set(name, dir);
    }

    type HandleState = {
      node: Extract<Node, { kind: "dir" }>;
    };
    const handleState = new WeakMap<object, HandleState>();
    const nodesByPath = new Map<string, Node>([["/mem", rootNode]]);
    for (const [name, child] of rootNode.children) {
      nodesByPath.set(`/mem/${name}`, child);
    }

    let openDirCalls = 0;
    let readDirCalls = 0;
    let lstatChildCalls = 0;

    const memFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async (absPath: string) => {
        openDirCalls += 1;
        const node = nodesByPath.get(absPath);
        if (!node || node.kind !== "dir") {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        const handle = {} as WatcherDirHandle;
        handleState.set(handle as object, { node });
        return handle;
      },
      readDir: async (handle: WatcherDirHandle, maxNames: number) => {
        readDirCalls += 1;
        const state = handleState.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const names: string[] = [];
        for (const name of state.node.children.keys()) {
          if (names.length >= maxNames) {
            return { status: "overflow" as const };
          }
          names.push(name);
        }
        return { status: "ok" as const, names };
      },
      lstatChild: async (handle: WatcherDirHandle, name: string) => {
        lstatChildCalls += 1;
        const state = handleState.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child) {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        if (child.kind === "dir") {
          return {
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            dev: child.dev,
            ino: child.ino,
            size: 64,
            mtimeNs: 1_000n,
            ctimeNs: 1_000n,
          };
        }
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          dev: child.dev,
          ino: child.ino,
          size: child.size,
          mtimeNs: child.mtimeNs,
          ctimeNs: child.ctimeNs,
        };
      },
      openChildDir: async (handle: WatcherDirHandle, name: string) => {
        openDirCalls += 1;
        const state = handleState.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child || child.kind !== "dir") {
          const error = new Error("ENOTDIR");
          (error as NodeJS.ErrnoException).code = "ENOTDIR";
          throw error;
        }
        const childHandle = {} as WatcherDirHandle;
        handleState.set(childHandle as object, { node: child });
        return childHandle;
      },
      closeDir: async () => undefined,
    };

    const built = await buildWatcherSnapshot("/mem", { fs: memFs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    expect(built.snapshot.entryCount).toBe(dirCount * 2);

    const visitedDirs = dirCount + 1;
    expect(readDirCalls).toBe(visitedDirs);
    // One lstatChild per child name across all visited dirs.
    expect(lstatChildCalls).toBe(dirCount + dirCount);

    readDirCalls = 0;
    lstatChildCalls = 0;
    openDirCalls = 0;
    const diff = await diffWatcherSnapshot("/mem", built.snapshot, [""], {
      fs: memFs,
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
    // Unchanged fingerprints: only the dirty root is enumerated.
    expect(readDirCalls).toBe(1);
    expect(lstatChildCalls).toBe(dirCount);
  });

  test("many sibling directory deletions are O(subtree) map visits, not O(map·dirs)", async () => {
    /**
     * Regression for quadratic full-map prefix scans on mass directory removal.
     * Instrument directory-map visits: hierarchical walk is Θ(subtree entries);
     * a prefix scan per removed dir would visit Θ(N · totalMaps).
     */
    const siblingCount = 400;
    const noiseCount = 2_000;

    // --- Direct helper: hierarchical remove must not scan the full map. ---
    const directories = new Map<
      string,
      Map<string, SnapshotEntryFingerprint>
    >();
    const rootEntries = new Map<string, SnapshotEntryFingerprint>();
    let inode = 1n;
    for (let i = 0; i < siblingCount; i += 1) {
      const name = `d${String(i).padStart(4, "0")}`;
      rootEntries.set(name, snapshotFingerprint("directory", inode++));
      directories.set(
        name,
        new Map([["f.md", snapshotFingerprint("file", inode++)]])
      );
    }
    for (let i = 0; i < noiseCount; i += 1) {
      const name = `noise-${String(i).padStart(4, "0")}`;
      rootEntries.set(name, snapshotFingerprint("directory", inode++));
      directories.set(
        name,
        new Map([["n.md", snapshotFingerprint("file", inode++)]])
      );
    }
    directories.set("", rootEntries);

    let entryCount = 0;
    for (const entries of directories.values()) {
      entryCount += entries.size;
    }

    let mapVisits = 0;
    const state = {
      directories: new Map(
        [...directories.entries()].map(([k, v]) => [k, new Map(v)])
      ),
      entryCount,
      unprovenSubtrees: new Set<string>(),
    };
    for (let i = 0; i < siblingCount; i += 1) {
      const name = `d${String(i).padStart(4, "0")}`;
      removeSubtreeFromMaps(state, name, {
        onDirectoryMapVisit: () => {
          mapVisits += 1;
        },
      });
      state.directories.get("")?.delete(name);
      state.entryCount -= 1;
    }

    const hierarchicalCeiling = siblingCount * 3;
    const quadraticFloor = siblingCount * (siblingCount + noiseCount) * 0.5;
    expect(mapVisits).toBeLessThanOrEqual(hierarchicalCeiling);
    expect(mapVisits).toBeLessThan(quadraticFloor);
    expect(mapVisits).toBeGreaterThanOrEqual(siblingCount);

    // --- End-to-end diff: build full tree, delete siblings, count map visits. ---
    type Node =
      | { kind: "dir"; children: Map<string, Node>; dev: bigint; ino: bigint }
      | {
          kind: "file";
          size: number;
          dev: bigint;
          ino: bigint;
          mtimeNs: bigint;
          ctimeNs: bigint;
        };
    let nextIno = 1n;
    const liveRoot: Extract<Node, { kind: "dir" }> = {
      kind: "dir",
      children: new Map(),
      dev: 1n,
      ino: nextIno++,
    };
    for (let i = 0; i < siblingCount; i += 1) {
      const name = `d${String(i).padStart(4, "0")}`;
      liveRoot.children.set(name, {
        kind: "dir",
        children: new Map([
          [
            "f.md",
            {
              kind: "file",
              size: 1,
              dev: 1n,
              ino: nextIno++,
              mtimeNs: 1_000n,
              ctimeNs: 1_000n,
            },
          ],
        ]),
        dev: 1n,
        ino: nextIno++,
      });
    }
    for (let i = 0; i < noiseCount; i += 1) {
      const name = `noise-${String(i).padStart(4, "0")}`;
      liveRoot.children.set(name, {
        kind: "dir",
        children: new Map([
          [
            "n.md",
            {
              kind: "file",
              size: 1,
              dev: 1n,
              ino: nextIno++,
              mtimeNs: 1_000n,
              ctimeNs: 1_000n,
            },
          ],
        ]),
        dev: 1n,
        ino: nextIno++,
      });
    }

    type HS = { node: Extract<Node, { kind: "dir" }> };
    const hs = new WeakMap<object, HS>();
    const liveFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async (absPath: string) => {
        if (absPath !== "/mem") {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        const handle = {} as WatcherDirHandle;
        hs.set(handle as object, { node: liveRoot });
        return handle;
      },
      readDir: async (handle: WatcherDirHandle, maxNames: number) => {
        const state = hs.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const names: string[] = [];
        for (const name of state.node.children.keys()) {
          if (names.length >= maxNames) {
            return { status: "overflow" as const };
          }
          names.push(name);
        }
        return { status: "ok" as const, names };
      },
      lstatChild: async (handle: WatcherDirHandle, name: string) => {
        const state = hs.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child) {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        if (child.kind === "dir") {
          return {
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            dev: child.dev,
            ino: child.ino,
            size: 64,
            mtimeNs: 1_000n,
            ctimeNs: 1_000n,
          };
        }
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          dev: child.dev,
          ino: child.ino,
          size: child.size,
          mtimeNs: child.mtimeNs,
          ctimeNs: child.ctimeNs,
        };
      },
      openChildDir: async (handle: WatcherDirHandle, name: string) => {
        const state = hs.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child || child.kind !== "dir") {
          const error = new Error("ENOTDIR");
          (error as NodeJS.ErrnoException).code = "ENOTDIR";
          throw error;
        }
        const childHandle = {} as WatcherDirHandle;
        hs.set(childHandle as object, { node: child });
        return childHandle;
      },
      closeDir: async () => undefined,
    };

    const built = await buildWatcherSnapshot("/mem", { fs: liveFs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    // Delete all sibling directories from the live tree (noise untouched).
    for (let i = 0; i < siblingCount; i += 1) {
      liveRoot.children.delete(`d${String(i).padStart(4, "0")}`);
    }

    let diffVisits = 0;
    const diff = await diffWatcherSnapshot("/mem", built.snapshot, [""], {
      fs: liveFs,
      mapHooks: {
        onDirectoryMapVisit: () => {
          diffVisits += 1;
        },
      },
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals.length).toBe(siblingCount);
    expect(diff.candidates).toEqual([]);
    // Hierarchical removals for siblings only — not quadratic over noise.
    expect(diffVisits).toBeLessThanOrEqual(siblingCount * 3);
    expect(diffVisits).toBeLessThan(
      siblingCount * (siblingCount + noiseCount) * 0.25
    );
  });

  test("one changed file among 5000 selects only that path with timing", async () => {
    const total = 5000;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < total; i += 1) {
      writes.push(
        writeWatchFixture(
          root,
          `f-${String(i).padStart(5, "0")}.md`,
          `body-${i}`
        )
      );
    }
    await Promise.all(writes);

    // Path-backed adapter: platform-independent (Windows production default falls back).
    const fs = createRealPathBackedWatcherFs();
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    expect(built.snapshot.entryCount).toBe(total);
    expect(built.snapshot.entryCount).toBeLessThanOrEqual(
      WATCHER_SNAPSHOT_ENTRY_CEILING
    );

    const target = "f-02500.md";
    await writeWatchFixture(root, target, "changed-body");

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([target]);
    expect(diff.removals).toEqual([]);
    expect(diff.discoveryMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(diff.discoveryMs)).toBe(true);
    expect(diff.discoveryMs).toBeLessThan(5_000);
  }, 60_000);
});
