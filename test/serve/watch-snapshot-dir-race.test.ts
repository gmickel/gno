/**
 * Directory open races for watcher snapshot diff (gno-27 task .1).
 *
 * Nested dirty-directory open failure (ENOENT/ENOTDIR) must fail closed —
 * never prove deletion or advance the snapshot. Deletion proof only comes
 * from a successful parent listing that observes the child absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../src/serve/watch-snapshot";

import {
  buildWatcherSnapshot,
  diffWatcherSnapshot,
  reconcileWatcherHints,
  resolveWatcherDirtyDirectory,
} from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";
import {
  createRealPathBackedWatcherFs,
  writeWatchFixture,
} from "./helpers/watch-snapshot-fixtures";

function expectScanFailedFallback(
  result: Awaited<ReturnType<typeof diffWatcherSnapshot>>
): void {
  expect(result.status).toBe("fallback");
  if (result.status !== "fallback") {
    return;
  }
  expect(result.reason).toBe("scan_failed");
  expect("candidates" in result).toBe(false);
  expect("removals" in result).toBe(false);
  expect("nextSnapshot" in result).toBe(false);
}

/** Fail openChildDir for a target once, after parent lstat still reports directory. */
function raceOpenChildDirFs(
  base: WatcherSnapshotFs,
  targetName: string,
  code: "ENOENT" | "ENOTDIR"
): WatcherSnapshotFs {
  return {
    supportsAnchoredHandles: true,
    openDir: (abs) => base.openDir(abs),
    readDir: (handle, max) => base.readDir(handle, max),
    lstatChild: (handle, name) => base.lstatChild(handle, name),
    openChildDir: async (handle, name) => {
      if (name === targetName) {
        throw Object.assign(new Error(`${code} race on ${name}`), { code });
      }
      return base.openChildDir(handle, name);
    },
    closeDir: (handle) => base.closeDir(handle),
  };
}

describe("watcher snapshot directory open races", () => {
  let root = "";
  let fs: WatcherSnapshotFs;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-dir-race-"));
    fs = createRealPathBackedWatcherFs();
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("ordinary recursive directory delete still proves removals via parent listing", async () => {
    await mkdir(join(root, "tree", "deep"), { recursive: true });
    await writeWatchFixture(root, "tree/a.md", "a");
    await writeWatchFixture(root, "tree/deep/b.md", "b");
    await writeWatchFixture(root, "sibling.md", "s");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "tree"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual(["tree/a.md", "tree/deep/b.md"]);
    expect(diff.nextSnapshot.directories.has("tree")).toBe(false);
    expect(diff.nextSnapshot.directories.get("")?.has("sibling.md")).toBe(true);
  });

  test("deleted directory hint climbs to parent and removes via parent listing", async () => {
    await mkdir(join(root, "keep", "nested"), { recursive: true });
    await writeWatchFixture(root, "keep/nested/a.md", "a");
    await writeWatchFixture(root, "keep/sibling.md", "s");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "keep", "nested"));

    const resolved = await resolveWatcherDirtyDirectory(
      root,
      "keep/nested/a.md",
      { fs }
    );
    expect(resolved).toEqual({ status: "ok", directory: "keep" });

    const reconciled = await reconcileWatcherHints(
      root,
      built.snapshot,
      ["keep/nested/a.md"],
      { fs }
    );
    expect(reconciled.status).toBe("ok");
    if (reconciled.status !== "ok") {
      return;
    }
    expect(reconciled.removals).toEqual(["keep/nested/a.md"]);
    expect(reconciled.candidates).toEqual([]);
    expect(reconciled.nextSnapshot.directories.has("keep/nested")).toBe(false);
    expect(
      reconciled.nextSnapshot.directories.get("keep")?.has("sibling.md")
    ).toBe(true);
  });

  for (const kind of ["file", "symlink", "other"] as const) {
    test(`directly requested nested dirty dir after resolve→${kind} is scan_failed`, async () => {
      await mkdir(join(root, "was-dir", "nested"), { recursive: true });
      await writeWatchFixture(root, "was-dir/a.md", "a");
      await writeWatchFixture(root, "was-dir/nested/b.md", "b");
      await writeWatchFixture(root, "keep.md", "k");

      const built = await buildWatcherSnapshot(root, { fs });
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        return;
      }

      // Resolve while the path is still a real directory.
      const resolved = await resolveWatcherDirtyDirectory(root, "was-dir", {
        fs,
      });
      expect(resolved).toEqual({ status: "ok", directory: "was-dir" });

      // Race: directory becomes file / symlink / other before diff open.
      await safeRm(join(root, "was-dir"));
      if (kind === "file") {
        await writeFile(join(root, "was-dir"), "now-a-file");
      } else if (kind === "symlink") {
        await writeFile(join(root, "target.md"), "t");
        await symlink(join(root, "target.md"), join(root, "was-dir"));
      } else {
        // Inject open-time ENOTDIR for the nested dirty target (other kind).
        const raceFs = raceOpenChildDirFs(fs, "was-dir", "ENOTDIR");
        const diff = await diffWatcherSnapshot(
          root,
          built.snapshot,
          ["was-dir"],
          { fs: raceFs }
        );
        expectScanFailedFallback(diff);
        expect(built.snapshot.directories.has("was-dir")).toBe(true);
        expect(built.snapshot.directories.get("was-dir")?.has("a.md")).toBe(
          true
        );
        expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
        return;
      }

      const diff = await diffWatcherSnapshot(
        root,
        built.snapshot,
        ["was-dir"],
        {
          fs,
        }
      );
      expectScanFailedFallback(diff);
      // Previous proven snapshot untouched.
      expect(built.snapshot.directories.has("was-dir")).toBe(true);
      expect(built.snapshot.directories.get("was-dir")?.has("a.md")).toBe(true);
      expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
    });
  }

  for (const code of ["ENOENT", "ENOTDIR"] as const) {
    test(`parent listed directory then recursive open ${code} is scan_failed`, async () => {
      await mkdir(join(root, "nested"), { recursive: true });
      await writeWatchFixture(root, "nested/a.md", "a");
      await writeWatchFixture(root, "keep.md", "k");

      const built = await buildWatcherSnapshot(root, { fs });
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        return;
      }

      const nestedFp = built.snapshot.directories.get("")?.get("nested");
      expect(nestedFp?.kind).toBe("directory");

      // Parent listing still observes nested as a directory with changed
      // fingerprint so diff recurses; recursive open then fails.
      const raceFs: WatcherSnapshotFs = {
        supportsAnchoredHandles: true,
        openDir: (abs) => fs.openDir(abs),
        readDir: (handle, max) => fs.readDir(handle, max),
        lstatChild: async (handle, name) => {
          const stat = await fs.lstatChild(handle, name);
          if (name === "nested" && stat.isDirectory()) {
            return {
              ...stat,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
              // Force fingerprint inequality so diff recurses into nested.
              ctimeNs:
                typeof stat.ctimeNs === "bigint"
                  ? stat.ctimeNs + 1n
                  : BigInt(stat.ctimeNs ?? 0) + 1n,
            } satisfies WatcherSnapshotStat;
          }
          return stat;
        },
        openChildDir: async (handle, name) => {
          if (name === "nested") {
            throw Object.assign(new Error(`${code} recursive race`), { code });
          }
          return fs.openChildDir(handle, name);
        },
        closeDir: (handle) => fs.closeDir(handle),
      };

      const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
        fs: raceFs,
      });
      expectScanFailedFallback(diff);
      expect(built.snapshot.directories.has("nested")).toBe(true);
      expect(built.snapshot.directories.get("nested")?.has("a.md")).toBe(true);
      expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
    });
  }

  for (const kind of ["file", "symlink", "other"] as const) {
    test(`parent lists directory then recursive open fails for dir→${kind} race`, async () => {
      await mkdir(join(root, "slot", "deep"), { recursive: true });
      await writeWatchFixture(root, "slot/a.md", "a");
      await writeWatchFixture(root, "slot/deep/b.md", "b");

      const built = await buildWatcherSnapshot(root, { fs });
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        return;
      }

      // Parent readdir/lstat still report a directory; openChildDir fails as if
      // the path was replaced by a non-directory between parent listing and open.
      const raceFs: WatcherSnapshotFs = {
        supportsAnchoredHandles: true,
        openDir: (abs) => fs.openDir(abs),
        readDir: (handle, maxNames) => fs.readDir(handle, maxNames),
        lstatChild: async (handle, name) => {
          const stat = await fs.lstatChild(handle, name);
          if (name !== "slot") {
            return stat;
          }
          // Report directory with bumped ctime so recursion is attempted.
          return {
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeNs: stat.mtimeNs,
            ctimeNs:
              typeof stat.ctimeNs === "bigint"
                ? stat.ctimeNs + 99n
                : BigInt(Number(stat.ctimeNs ?? 0)) + 99n,
          };
        },
        openChildDir: async (handle, name) => {
          if (name === "slot") {
            // Kind-specific replacement error surface: ENOTDIR for non-dir races,
            // ENOENT for pure vanish-style other races.
            const code = kind === "other" ? "ENOENT" : "ENOTDIR";
            throw Object.assign(new Error(`dir→${kind} open race`), { code });
          }
          return fs.openChildDir(handle, name);
        },
        closeDir: (handle) => fs.closeDir(handle),
      };

      const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
        fs: raceFs,
      });
      expectScanFailedFallback(diff);
      expect(built.snapshot.directories.has("slot")).toBe(true);
      expect(built.snapshot.directories.has("slot/deep")).toBe(true);
      expect(built.snapshot.directories.get("slot")?.has("a.md")).toBe(true);
    });
  }

  test("direct nested dirty open ENOTDIR never proves subtree deletion", async () => {
    await mkdir(join(root, "victim", "inner"), { recursive: true });
    await writeWatchFixture(root, "victim/x.md", "x");
    await writeWatchFixture(root, "victim/inner/y.md", "y");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const raceFs = raceOpenChildDirFs(fs, "victim", "ENOTDIR");
    const diff = await diffWatcherSnapshot(root, built.snapshot, ["victim"], {
      fs: raceFs,
    });
    expectScanFailedFallback(diff);
    // Snapshot still has full subtree — no false removals.
    expect(built.snapshot.directories.get("victim")?.has("x.md")).toBe(true);
    expect(built.snapshot.directories.get("victim/inner")?.has("y.md")).toBe(
      true
    );
  });
});
