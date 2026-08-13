/**
 * Watcher hierarchical snapshot / diff primitives (gno-27 task .1).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SnapshotEntryFingerprint,
  WatcherSnapshot,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../src/serve/watch-snapshot";

import {
  WATCHER_SNAPSHOT_ENTRY_CEILING,
  buildWatcherSnapshot,
  createEmptyWatcherSnapshot,
  diffWatcherSnapshot,
  fingerprintsEqual,
  normalizeWatcherRelPath,
  reconcileWatcherHints,
  resolveWatcherDirtyDirectory,
} from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";

async function write(root: string, rel: string, body = "x"): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body);
}

describe("normalizeWatcherRelPath", () => {
  test("accepts relative POSIX paths and strips . segments", () => {
    expect(normalizeWatcherRelPath("a/b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath("./a/./b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath("a\\b.md")).toBe("a/b.md");
    expect(normalizeWatcherRelPath(".")).toBe("");
    expect(normalizeWatcherRelPath("")).toBe("");
  });

  test("rejects absolute, escaping, drive-shaped, and NUL paths", () => {
    expect(normalizeWatcherRelPath("/etc/passwd")).toBeNull();
    expect(normalizeWatcherRelPath("../outside")).toBeNull();
    expect(normalizeWatcherRelPath("a/../../x")).toBeNull();
    expect(normalizeWatcherRelPath("C:/windows")).toBeNull();
    expect(normalizeWatcherRelPath("a\0b")).toBeNull();
  });
});

describe("buildWatcherSnapshot + diffWatcherSnapshot", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-snap-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("unchanged dirty directory yields no candidates and preserves fingerprints", async () => {
    await write(root, "a.md", "one");
    await write(root, "b.md", "two");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.nextSnapshot.entryCount).toBe(built.snapshot.entryCount);
  });

  test("added, changed, and removed files are selected", async () => {
    await write(root, "keep.md", "k");
    await write(root, "gone.md", "g");
    await write(root, "edit.md", "old");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await write(root, "new.md", "n");
    await write(root, "edit.md", "new-body");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "gone.md"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates.sort()).toEqual(["edit.md", "gone.md", "new.md"]);
  });

  test("nested change does not select untouched siblings", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await write(root, "root.md", "r");
    await write(root, "sub/keep.md", "k");
    await write(root, "sub/edit.md", "old");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await write(root, "sub/edit.md", "new");

    const diff = await diffWatcherSnapshot(root, built.snapshot, ["sub"]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["sub/edit.md"]);
  });

  test("removed directory expands prior nested files from the snapshot", async () => {
    await mkdir(join(root, "tree", "deep"), { recursive: true });
    await write(root, "tree/a.md", "a");
    await write(root, "tree/deep/b.md", "b");
    await write(root, "sibling.md", "s");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "tree"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates.sort()).toEqual(["tree/a.md", "tree/deep/b.md"]);
    // Proven snapshot advances only after successful classification.
    expect(diff.nextSnapshot.directories.has("tree")).toBe(false);
    expect(diff.nextSnapshot.directories.has("tree/deep")).toBe(false);
  });

  test("atomic replacement changes inode/ctime and selects the path", async () => {
    await write(root, "note.md", "v1");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const { rename, unlink } = await import("node:fs/promises");
    const tmp = join(root, "note.md.tmp");
    await writeFile(tmp, "v2");
    await unlink(join(root, "note.md"));
    await rename(tmp, join(root, "note.md"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["note.md"]);
  });

  test("nearest surviving ancestor for a missing nested hint", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await write(root, "a/b/c.md", "c");
    await write(root, "a/sibling.md", "s");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "a", "b"));

    const resolved = await resolveWatcherDirtyDirectory(root, "a/b/c.md");
    expect(resolved).toEqual({ status: "ok", directory: "a" });

    const reconciled = await reconcileWatcherHints(root, built.snapshot, [
      "a/b/c.md",
    ]);
    expect(reconciled.status).toBe("ok");
    if (reconciled.status !== "ok") {
      return;
    }
    // Climbing to `a` surfaces the removed nested file and leaves sibling alone
    // only if sibling fingerprint is unchanged — sibling is still under `a`.
    expect(reconciled.candidates).toContain("a/b/c.md");
    expect(reconciled.candidates).not.toContain("a/sibling.md");
  });

  test("symlink entries are recorded but not followed", async () => {
    await write(root, "inside.md", "in");
    const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-out-"));
    try {
      await writeFile(join(outsideDir, "secret.md"), "secret");
      await symlink(outsideDir, join(root, "link-out"), "dir");
      await symlink(join(root, "inside.md"), join(root, "link-file"));

      const built = await buildWatcherSnapshot(root);
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

  test("invalid and outside-root hints are rejected without scanning", async () => {
    await write(root, "ok.md", "o");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    for (const hint of ["/etc/passwd", "../escape", "C:/windows", "a\0b"]) {
      const resolved = await resolveWatcherDirtyDirectory(root, hint);
      expect(resolved.status).toBe("invalid");
    }

    const reconciled = await reconcileWatcherHints(root, built.snapshot, [
      "/etc/passwd",
      "../escape",
    ]);
    expect(reconciled.status).toBe("ok");
    if (reconciled.status !== "ok") {
      return;
    }
    expect(reconciled.candidates).toEqual([]);
    expect(reconciled.nextSnapshot).toBe(built.snapshot);
  });

  test("unreliable metadata forces fallback without mutating the proven snapshot", async () => {
    await write(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const realFs = {
      readdir: async (absPath: string) => {
        const { readdir } = await import("node:fs/promises");
        return readdir(absPath);
      },
      lstat: async (absPath: string): Promise<WatcherSnapshotStat> => {
        const { lstat } = await import("node:fs/promises");
        const stat = await lstat(absPath, { bigint: true });
        return {
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
          isSymbolicLink: () => stat.isSymbolicLink(),
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
          unreliable: true,
        };
      },
    } satisfies WatcherSnapshotFs;

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: realFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("unreliable_metadata");
    // Caller retains the last proven snapshot (we did not return a next one).
  });

  test("ceiling overflow falls back and does not return a next snapshot", async () => {
    await write(root, "a.md", "a");
    await write(root, "b.md", "b");
    await write(root, "c.md", "c");

    const built = await buildWatcherSnapshot(root, { entryCeiling: 2 });
    expect(built.status).toBe("fallback");
    if (built.status !== "fallback") {
      return;
    }
    expect(built.reason).toBe("overflow");

    const okBuild = await buildWatcherSnapshot(root);
    expect(okBuild.status).toBe("ok");
    if (okBuild.status !== "ok") {
      return;
    }

    await write(root, "d.md", "d");
    const overflowDiff = await diffWatcherSnapshot(
      root,
      okBuild.snapshot,
      [""],
      { entryCeiling: okBuild.snapshot.entryCount }
    );
    expect(overflowDiff.status).toBe("fallback");
    if (overflowDiff.status !== "fallback") {
      return;
    }
    expect(overflowDiff.reason).toBe("overflow");
  });

  test("failed scan never proves removals", async () => {
    await write(root, "keep.md", "k");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const failingFs: WatcherSnapshotFs = {
      readdir: async () => {
        const error = new Error("EACCES");
        (error as NodeJS.ErrnoException).code = "EACCES";
        throw error;
      },
      lstat: async () => {
        throw new Error("unused");
      },
    };

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: failingFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
    // Proven snapshot still has the file — caller must not inactivate on this.
    expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
  });

  test("missing collection root is scan_failed, not mass deletion", async () => {
    await write(root, "keep.md", "k");
    await write(root, "nested/a.md", "a");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const missingRootFs: WatcherSnapshotFs = {
      readdir: async () => {
        const error = new Error("ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
      lstat: async () => {
        const error = new Error("ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        throw error;
      },
    };

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
    // No nextSnapshot field on fallback — proven state is caller-owned and intact.
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
    await write(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const msOnlyFs: WatcherSnapshotFs = {
      readdir: async (absPath: string) => {
        const { readdir } = await import("node:fs/promises");
        return readdir(absPath);
      },
      lstat: async (absPath: string): Promise<WatcherSnapshotStat> => {
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
      },
    };

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: msOnlyFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("unreliable_metadata");
  });

  test("directory→outside-symlink swap mid-scan fails closed without outside lstat", async () => {
    await mkdir(join(root, "victim"), { recursive: true });
    await write(root, "victim/inside.md", "in");
    await write(root, "root.md", "r");

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-swap-out-"));
    const outsideSecret = join(outsideDir, "secret.md");
    await writeFile(outsideSecret, "secret");

    const { lstat, readdir, rm } = await import("node:fs/promises");
    const realLstat = async (absPath: string): Promise<WatcherSnapshotStat> => {
      const stat = await lstat(absPath, { bigint: true });
      return {
        isFile: () => stat.isFile(),
        isDirectory: () => stat.isDirectory(),
        isSymbolicLink: () => stat.isSymbolicLink(),
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
      };
    };

    const victimAbs = join(root, "victim");
    let victimPreLstats = 0;
    const childLstats: string[] = [];

    const racingFs: WatcherSnapshotFs = {
      readdir: async (absPath: string) => {
        if (absPath === victimAbs) {
          // After parent listed `victim` as a directory, replace it with an
          // outside symlink before this directory's own enumeration completes.
          await rm(victimAbs, { recursive: true, force: true });
          await symlink(outsideDir, victimAbs, "dir");
        }
        return readdir(absPath);
      },
      lstat: async (absPath: string): Promise<WatcherSnapshotStat> => {
        if (absPath === victimAbs) {
          victimPreLstats += 1;
          // First lstat (pre-readdir identity): still a real directory.
          // Subsequent lstat (post-readdir): sees the outside symlink.
          if (victimPreLstats === 1) {
            return {
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
              dev: 1n,
              ino: 42n,
              size: 64,
              mtimeNs: 1_000n,
              ctimeNs: 1_000n,
            };
          }
          return realLstat(absPath);
        }
        // Any child under the swapped path would be outside the collection.
        if (
          absPath === outsideSecret ||
          absPath.startsWith(outsideDir + "/") ||
          absPath.startsWith(outsideDir + "\\")
        ) {
          childLstats.push(absPath);
          return realLstat(absPath);
        }
        // Also catch joins that resolve through the symlink path string.
        if (absPath.includes("secret.md")) {
          childLstats.push(absPath);
        }
        return realLstat(absPath);
      },
    };

    try {
      // Dirty the nested directory so enumeration runs on the race target
      // (unchanged root fingerprints would not recurse into `victim`).
      const diff = await diffWatcherSnapshot(root, built.snapshot, ["victim"], {
        fs: racingFs,
      });
      expect(diff.status).toBe("fallback");
      if (diff.status !== "fallback") {
        return;
      }
      expect(diff.reason).toBe("scan_failed");
      // Fail closed: never lstat outside children after the identity change.
      expect(childLstats).toEqual([]);
      // Proven snapshot is not advanced (no nextSnapshot on fallback).
      expect(built.snapshot.directories.get("victim")?.has("inside.md")).toBe(
        true
      );
    } finally {
      await safeRm(outsideDir);
    }
  });

  test("many-directory scans stay linear in readdir and lstat operations", async () => {
    // Pure in-memory tree: N sibling directories each with one file.
    // Linear bound: readdir once per visited dir; lstat = 2*dirs (identity)
    // + children. Quadratic map recount / queue.shift would not inflate I/O,
    // but we still assert tight linear op ceilings so a regression to
    // re-walking every map between dirs (if reintroduced as I/O) fails.
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

    const resolveNode = (absPath: string): Node | null => {
      if (absPath === "/mem") {
        return rootNode;
      }
      if (!absPath.startsWith("/mem/")) {
        return null;
      }
      const parts = absPath.slice("/mem/".length).split("/").filter(Boolean);
      let cursor: Node = rootNode;
      for (const part of parts) {
        if (cursor.kind !== "dir") {
          return null;
        }
        const next = cursor.children.get(part);
        if (!next) {
          return null;
        }
        cursor = next;
      }
      return cursor;
    };

    let readdirCalls = 0;
    let lstatCalls = 0;

    const memFs: WatcherSnapshotFs = {
      readdir: async (absPath: string) => {
        readdirCalls += 1;
        const node = resolveNode(absPath);
        if (!node || node.kind !== "dir") {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
        return [...node.children.keys()];
      },
      lstat: async (absPath: string): Promise<WatcherSnapshotStat> => {
        lstatCalls += 1;
        const node = resolveNode(absPath);
        if (!node) {
          const error = new Error("ENOENT");
          (error as NodeJS.ErrnoException).code = "ENOENT";
          throw error;
        }
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
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          dev: node.dev,
          ino: node.ino,
          size: node.size,
          mtimeNs: node.mtimeNs,
          ctimeNs: node.ctimeNs,
        };
      },
    };

    const built = await buildWatcherSnapshot("/mem", { fs: memFs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    // Root has dirCount dirs; each subdir has 1 file → 2 * dirCount entries.
    expect(built.snapshot.entryCount).toBe(dirCount * 2);

    // Visited directories: root + dirCount children.
    const visitedDirs = dirCount + 1;
    expect(readdirCalls).toBe(visitedDirs);
    // Per visited dir: pre-lstat + post-lstat; plus one lstat per child name.
    // Root children: dirCount; each subdir children: 1 → dirCount files.
    const expectedLstats = 2 * visitedDirs + dirCount + dirCount;
    expect(lstatCalls).toBe(expectedLstats);

    // Unchanged root diff must also stay linear (not re-scan every subtree).
    readdirCalls = 0;
    lstatCalls = 0;
    const diff = await diffWatcherSnapshot("/mem", built.snapshot, [""], {
      fs: memFs,
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    // Unchanged fingerprints: only the dirty root is enumerated.
    expect(readdirCalls).toBe(1);
    expect(lstatCalls).toBe(2 + dirCount);
  });

  test("one changed file among 5000 selects only that path with timing", async () => {
    const total = 5000;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < total; i += 1) {
      writes.push(
        write(root, `f-${String(i).padStart(5, "0")}.md`, `body-${i}`)
      );
    }
    await Promise.all(writes);

    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    expect(built.snapshot.entryCount).toBe(total);
    expect(built.snapshot.entryCount).toBeLessThanOrEqual(
      WATCHER_SNAPSHOT_ENTRY_CEILING
    );

    const target = "f-02500.md";
    await write(root, target, "changed-body");

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""]);
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([target]);
    // Discovery only — no ingestion. Record timing for the R4 budget path.
    expect(diff.discoveryMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(diff.discoveryMs)).toBe(true);
    // Soft budget (macOS/Linux p95 is 250 ms in the live protocol; keep a
    // generous CI bound so flaky hosts do not fail the primitive unit test).
    expect(diff.discoveryMs).toBeLessThan(5_000);
  }, 60_000);
});

describe("fingerprintsEqual", () => {
  test("detects inode replacement with preserved size/mtime", () => {
    const base: SnapshotEntryFingerprint = {
      kind: "file",
      device: 1n,
      inode: 10n,
      size: 100,
      mtimeNs: 1_000n,
      ctimeNs: 2_000n,
    };
    expect(
      fingerprintsEqual(base, {
        ...base,
        inode: 11n,
        ctimeNs: 3_000n,
      })
    ).toBe(false);
    expect(fingerprintsEqual(base, { ...base })).toBe(true);
  });
});

describe("createEmptyWatcherSnapshot", () => {
  test("starts with zero entries", () => {
    const empty: WatcherSnapshot = createEmptyWatcherSnapshot();
    expect(empty.entryCount).toBe(0);
    expect(empty.directories.size).toBe(0);
  });
});
