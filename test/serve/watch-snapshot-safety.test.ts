/**
 * Safety/fallback paths for watcher snapshots (gno-27 task .1).
 *
 * Generic tests inject path-backed FS (platform-independent). Production
 * adapter coverage lives in watch-snapshot-production.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WatcherSnapshotFs } from "../../src/serve/watch-snapshot";

import {
  buildWatcherSnapshot,
  createPathBackedWatcherFs,
  diffWatcherSnapshot,
  reconcileWatcherHints,
  resolveWatcherDirtyDirectory,
} from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";
import {
  createRealPathBackedWatcherFs,
  realLstatAsWatcherStat,
  writeWatchFixture,
} from "./helpers/watch-snapshot-fixtures";

describe("watcher snapshot safety + fallback", () => {
  let root = "";
  let fs: WatcherSnapshotFs;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-snap-"));
    fs = createRealPathBackedWatcherFs();
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("symlink entries are recorded but not followed", async () => {
    await writeWatchFixture(root, "inside.md", "in");
    const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-out-"));
    try {
      await writeFile(join(outsideDir, "secret.md"), "secret");
      await symlink(outsideDir, join(root, "link-out"), "dir");
      await symlink(join(root, "inside.md"), join(root, "link-file"));

      const built = await buildWatcherSnapshot(root, { fs });
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        return;
      }

      const rootEntries = built.snapshot.directories.get("");
      expect(rootEntries?.get("link-out")?.kind).toBe("symlink");
      expect(rootEntries?.get("link-file")?.kind).toBe("symlink");
      // Must not have walked into the outside directory.
      expect(built.snapshot.directories.has("link-out")).toBe(false);
      const allFiles = [...built.snapshot.directories.values()].flatMap((m) => [
        ...m.keys(),
      ]);
      expect(allFiles).not.toContain("secret.md");
    } finally {
      await safeRm(outsideDir);
    }
  });

  test("link-out/secret.md hint never lstats outside child metadata", async () => {
    await writeWatchFixture(root, "inside.md", "in");
    const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-linkout-"));
    const outsideSecret = join(outsideDir, "secret.md");
    await writeFile(outsideSecret, "secret");
    await symlink(outsideDir, join(root, "link-out"), "dir");

    const childMetaCalls: string[] = [];

    const base = createPathBackedWatcherFs({
      readdir: async (absPath: string) => {
        const { readdir } = await import("node:fs/promises");
        return readdir(absPath);
      },
      lstat: realLstatAsWatcherStat,
    });

    const trackingFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: (abs) => base.openDir(abs),
      readDir: (h, maxNames) => base.readDir(h, maxNames),
      openChildDir: (h, name) => {
        childMetaCalls.push(`openChild:${name}`);
        return base.openChildDir(h, name);
      },
      lstatChild: async (h, name) => {
        childMetaCalls.push(`lstatChild:${name}`);
        return base.lstatChild(h, name);
      },
      closeDir: (h) => base.closeDir(h),
    };

    try {
      const resolved = await resolveWatcherDirtyDirectory(
        root,
        "link-out/secret.md",
        { fs: trackingFs }
      );
      // Symlink component stops descent; containing dirty dir is root.
      expect(resolved).toEqual({ status: "ok", directory: "" });
      // Only the first component is inspected — never secret.md.
      expect(childMetaCalls).toEqual(["lstatChild:link-out"]);
      expect(childMetaCalls.some((c) => c.includes("secret"))).toBe(false);
    } finally {
      await safeRm(outsideDir);
    }
  });

  test("invalid and outside-root hints are rejected without scanning", async () => {
    await writeWatchFixture(root, "ok.md", "o");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    for (const hint of ["/etc/passwd", "../escape", "C:/windows", "a\0b"]) {
      const resolved = await resolveWatcherDirtyDirectory(root, hint, { fs });
      expect(resolved.status).toBe("invalid");
    }

    const reconciled = await reconcileWatcherHints(
      root,
      built.snapshot,
      ["/etc/passwd", "../escape"],
      { fs }
    );
    expect(reconciled.status).toBe("ok");
    if (reconciled.status !== "ok") {
      return;
    }
    expect(reconciled.candidates).toEqual([]);
    expect(reconciled.removals).toEqual([]);
    expect(reconciled.nextSnapshot).toBe(built.snapshot);
  });

  test("unreliable metadata forces fallback without mutating the proven snapshot", async () => {
    await writeWatchFixture(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const realFs = createRealPathBackedWatcherFs(async (absPath) => {
      const stat = await realLstatAsWatcherStat(absPath);
      return { ...stat, unreliable: true };
    });

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: realFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("unreliable_metadata");
  });

  test("ceiling overflow falls back and does not return a next snapshot", async () => {
    await writeWatchFixture(root, "a.md", "a");
    await writeWatchFixture(root, "b.md", "b");
    await writeWatchFixture(root, "c.md", "c");

    const built = await buildWatcherSnapshot(root, { entryCeiling: 2, fs });
    expect(built.status).toBe("fallback");
    if (built.status !== "fallback") {
      return;
    }
    expect(built.reason).toBe("overflow");

    const okBuild = await buildWatcherSnapshot(root, { fs });
    expect(okBuild.status).toBe("ok");
    if (okBuild.status !== "ok") {
      return;
    }

    await writeWatchFixture(root, "d.md", "d");
    const overflowDiff = await diffWatcherSnapshot(
      root,
      okBuild.snapshot,
      [""],
      { entryCeiling: okBuild.snapshot.entryCount, fs }
    );
    expect(overflowDiff.status).toBe("fallback");
    if (overflowDiff.status !== "fallback") {
      return;
    }
    expect(overflowDiff.reason).toBe("overflow");
  });

  test("enumeration and stats stop at remaining+1 before materializing overflow", async () => {
    type Node =
      | { kind: "dir"; children: Map<string, Node> }
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
    };
    // 8 files; ceiling 3 → overflow after observing remaining+1 names/stats.
    for (let i = 0; i < 8; i += 1) {
      rootNode.children.set(`f${i}.md`, {
        kind: "file",
        size: 1,
        dev: 1n,
        ino: nextIno++,
        mtimeNs: 1_000n,
        ctimeNs: 1_000n,
      });
    }

    type HS = { node: Extract<Node, { kind: "dir" }> };
    const hs = new WeakMap<object, HS>();
    let namesExamined = 0;
    let lstatCalls = 0;

    const memFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async (absPath: string) => {
        if (absPath !== "/mem") {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        const handle =
          {} as import("../../src/serve/watch-snapshot").WatcherDirHandle;
        hs.set(handle as object, { node: rootNode });
        return handle;
      },
      readDir: async (handle, maxNames) => {
        const state = hs.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const names: string[] = [];
        for (const name of state.node.children.keys()) {
          namesExamined += 1;
          if (names.length >= maxNames) {
            return { status: "overflow" };
          }
          names.push(name);
        }
        return { status: "ok", names };
      },
      lstatChild: async (handle, name) => {
        lstatCalls += 1;
        const state = hs.get(handle as object);
        if (!state) {
          throw Object.assign(new Error("EBADF"), { code: "EBADF" });
        }
        const child = state.node.children.get(name);
        if (!child || child.kind !== "file") {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
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
      openChildDir: async () => {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      },
      closeDir: async () => undefined,
    };

    const ceiling = 3;
    const built = await buildWatcherSnapshot("/mem", {
      fs: memFs,
      entryCeiling: ceiling,
    });
    expect(built.status).toBe("fallback");
    if (built.status !== "fallback") {
      return;
    }
    expect(built.reason).toBe("overflow");
    // Prove work stops at remaining+1: one extra name for overflow evidence,
    // and no stats once readdir already overflowed.
    expect(namesExamined).toBe(ceiling + 1);
    expect(namesExamined).toBeLessThan(8);
    expect(lstatCalls).toBe(0);
    expect("snapshot" in built).toBe(false);
  });

  test("failed scan never proves removals", async () => {
    await writeWatchFixture(root, "keep.md", "k");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const failingFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async () => {
        const error = new Error("EACCES");
        (error as NodeJS.ErrnoException).code = "EACCES";
        throw error;
      },
      readDir: async () => {
        throw new Error("unused");
      },
      lstatChild: async () => {
        throw new Error("unused");
      },
      openChildDir: async () => {
        throw new Error("unused");
      },
      closeDir: async () => undefined,
    } satisfies WatcherSnapshotFs;

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: failingFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
    expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
  });

  test("missing collection root is scan_failed, not mass deletion", async () => {
    await writeWatchFixture(root, "keep.md", "k");
    await writeWatchFixture(root, "nested/a.md", "a");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const missingRootFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: async () => {
        const error = new Error("ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
      readDir: async () => {
        throw new Error("unused");
      },
      lstatChild: async () => {
        throw new Error("unused");
      },
      openChildDir: async () => {
        throw new Error("unused");
      },
      closeDir: async () => undefined,
    } satisfies WatcherSnapshotFs;

    const resolved = await resolveWatcherDirtyDirectory(root, "keep.md", {
      fs: missingRootFs,
    });
    expect(resolved.status).toBe("fallback");
    if (resolved.status === "fallback") {
      expect(resolved.reason).toBe("scan_failed");
    }

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: missingRootFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
    expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
    expect(built.snapshot.directories.get("nested")?.has("a.md")).toBe(true);

    const reconciled = await reconcileWatcherHints(
      root,
      built.snapshot,
      ["keep.md", "nested/a.md"],
      { fs: missingRootFs }
    );
    expect(reconciled.status).toBe("fallback");
    if (reconciled.status !== "fallback") {
      return;
    }
    expect(reconciled.reason).toBe("scan_failed");
  });

  test("millisecond-only timestamps are unreliable_metadata", async () => {
    await writeWatchFixture(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const msOnlyFs = createRealPathBackedWatcherFs(async (absPath) => {
      const { lstat } = await import("node:fs/promises");
      const stat = await lstat(absPath, { bigint: true });
      return {
        isFile: () => stat.isFile(),
        isDirectory: () => stat.isDirectory(),
        isSymbolicLink: () => stat.isSymbolicLink(),
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        // Intentionally omit mtimeNs/ctimeNs — only ms present.
        mtimeMs: Number(stat.mtimeNs) / 1_000_000,
        ctimeMs: Number(stat.ctimeNs) / 1_000_000,
      };
    });

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: msOnlyFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("unreliable_metadata");
  });

  test("unsupported anchored handles fall back rather than path-scanning", async () => {
    await writeWatchFixture(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const unsupported: WatcherSnapshotFs = {
      supportsAnchoredHandles: false,
      openDir: async () => {
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      },
      readDir: async () => ({ status: "ok", names: [] }),
      lstatChild: async () => {
        throw new Error("unused");
      },
      openChildDir: async () => {
        throw new Error("unused");
      },
      closeDir: async () => undefined,
    };

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: unsupported,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
  });
});
