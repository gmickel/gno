/**
 * Anchored-handle pin identity (TOCTOU) for watcher snapshots (gno-27 task .1).
 */

import { describe, expect, test } from "bun:test";

import type {
  WatcherDirHandle,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../src/serve/watch-snapshot";

import {
  buildWatcherSnapshot,
  diffWatcherSnapshot,
} from "../../src/serve/watch-snapshot";

describe("watcher snapshot handle pin", () => {
  test("anchored handle pin survives path swap after open (no outside child lstat)", async () => {
    /**
     * Proves residual TOCTOU after a "second parent check" cannot redirect
     * child stats: handles pin the opened directory identity. After openDir,
     * swapping the path to an outside symlink still resolves children against
     * the pinned handle — outside secret.md is never lstatChild'd.
     */
    type Node =
      | {
          kind: "dir";
          children: Map<string, Node>;
          dev: bigint;
          ino: bigint;
        }
      | {
          kind: "file" | "symlink";
          target?: string;
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

    const victim: Extract<Node, { kind: "dir" }> = {
      kind: "dir",
      children: new Map([
        [
          "inside.md",
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
    };
    rootNode.children.set("victim", victim);
    rootNode.children.set("root.md", {
      kind: "file",
      size: 1,
      dev: 1n,
      ino: nextIno++,
      mtimeNs: 1_000n,
      ctimeNs: 1_000n,
    });

    // Outside tree (should never be touched via lstatChild after pin).
    const outsideSecretIno = nextIno++;
    const outside: Extract<Node, { kind: "dir" }> = {
      kind: "dir",
      children: new Map([
        [
          "secret.md",
          {
            kind: "file",
            size: 6,
            dev: 99n,
            ino: outsideSecretIno,
            mtimeNs: 9_000n,
            ctimeNs: 9_000n,
          },
        ],
      ]),
      dev: 99n,
      ino: nextIno++,
    };

    // Live path binding: "/mem" → rootNode. After open of victim, swap path.
    const pathBinding = new Map<string, Node>([["/mem", rootNode]]);
    pathBinding.set("/mem/victim", victim);

    type HandleState = {
      node: Extract<Node, { kind: "dir" }>;
      closed: boolean;
    };
    const handleState = new WeakMap<object, HandleState>();
    const outsideChildCalls: string[] = [];
    let victimOpened = false;

    const statOf = (node: Node): WatcherSnapshotStat => {
      if (node.kind === "dir") {
        return {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          dev: node.dev,
          ino: node.ino,
          size: 64,
          mtimeNs: 1_000n,
          ctimeNs: 1_000n,
        };
      }
      return {
        isFile: () => node.kind === "file",
        isDirectory: () => false,
        isSymbolicLink: () => node.kind === "symlink",
        dev: node.dev,
        ino: node.ino,
        size: node.size,
        mtimeNs: node.mtimeNs,
        ctimeNs: node.ctimeNs,
      };
    };

    const pinFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async (absPath: string) => {
        const node = pathBinding.get(absPath);
        if (!node || node.kind !== "dir") {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        const handle = {} as WatcherDirHandle;
        handleState.set(handle as object, { node, closed: false });
        if (absPath.endsWith("/victim") || absPath === "/mem/victim") {
          victimOpened = true;
          // Residual race: after open (would be after second parent check in
          // the old path-based design), swap the path to an outside symlink.
          pathBinding.set("/mem/victim", {
            kind: "symlink",
            target: "/outside",
            size: 8,
            dev: 1n,
            ino: nextIno++,
            mtimeNs: 2_000n,
            ctimeNs: 2_000n,
          });
          pathBinding.set("/outside", outside);
        }
        return handle;
      },
      readDir: async (handle: WatcherDirHandle, maxNames: number) => {
        const state = handleState.get(handle as object);
        if (!state || state.closed) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        // Names come from the pinned node, not the swapped path.
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
        const state = handleState.get(handle as object);
        if (!state || state.closed) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        if (state.node === outside || name === "secret.md") {
          outsideChildCalls.push(name);
        }
        // Resolve relative to the pinned directory node only.
        const child = state.node.children.get(name);
        if (!child) {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        if (child.kind !== "dir" && child.ino === outsideSecretIno) {
          outsideChildCalls.push(name);
        }
        return statOf(child);
      },
      openChildDir: async (handle: WatcherDirHandle, name: string) => {
        const state = handleState.get(handle as object);
        if (!state || state.closed) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child || child.kind !== "dir") {
          const error = new Error("ENOTDIR");
          (error as NodeJS.ErrnoException).code = "ENOTDIR";
          throw error;
        }
        const childHandle = {} as WatcherDirHandle;
        handleState.set(childHandle as object, { node: child, closed: false });
        if (name === "victim") {
          victimOpened = true;
          pathBinding.set("/mem/victim", {
            kind: "symlink",
            target: "/outside",
            size: 8,
            dev: 1n,
            ino: nextIno++,
            mtimeNs: 2_000n,
            ctimeNs: 2_000n,
          });
          pathBinding.set("/outside", outside);
        }
        return childHandle;
      },
      closeDir: async (handle: WatcherDirHandle) => {
        const state = handleState.get(handle as object);
        if (state) {
          state.closed = true;
        }
      },
    };

    const built = await buildWatcherSnapshot("/mem", { fs: pinFs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    outsideChildCalls.length = 0;
    victimOpened = false;
    // Restore victim path for openDirByRel walk from root.
    pathBinding.set("/mem/victim", victim);

    const diff = await diffWatcherSnapshot("/mem", built.snapshot, ["victim"], {
      fs: pinFs,
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(victimOpened).toBe(true);
    // Children resolved against pinned victim, never outside secret.md.
    expect(outsideChildCalls).toEqual([]);
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
  });
});
