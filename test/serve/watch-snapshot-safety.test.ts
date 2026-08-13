/**
 * Safety/fallback paths for watcher snapshots (gno-27 task .1).
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
import { createDefaultWatcherFs } from "../../src/serve/watch-snapshot-handles";
import { safeRm } from "../helpers/cleanup";
import {
  createRealPathBackedWatcherFs,
  realLstatAsWatcherStat,
  writeWatchFixture,
} from "./helpers/watch-snapshot-fixtures";

describe("watcher snapshot safety + fallback", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-snap-"));
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
      readDir: (h) => base.readDir(h),
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
    expect(reconciled.removals).toEqual([]);
    expect(reconciled.nextSnapshot).toBe(built.snapshot);
  });

  test("unreliable metadata forces fallback without mutating the proven snapshot", async () => {
    await writeWatchFixture(root, "a.md", "a");
    const built = await buildWatcherSnapshot(root);
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

    await writeWatchFixture(root, "d.md", "d");
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
    await writeWatchFixture(root, "keep.md", "k");
    const built = await buildWatcherSnapshot(root);
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
    };

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
    const built = await buildWatcherSnapshot(root);
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
    const built = await buildWatcherSnapshot(root);
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
    const built = await buildWatcherSnapshot(root);
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const unsupported: WatcherSnapshotFs = {
      supportsAnchoredHandles: false,
      openDir: async () => {
        throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
      },
      readDir: async () => [],
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

  test("createDefaultWatcherFs builds a real production snapshot on this platform", async () => {
    /**
     * Exercises the native libc/dirent path (not an injected adapter).
     * Broken libc load or dirent layout must fail here rather than hide behind
     * path-backed test doubles.
     */
    const productionFs = createDefaultWatcherFs();

    if (process.platform === "win32") {
      expect(productionFs.supportsAnchoredHandles).toBe(false);
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      if (built.status === "fallback") {
        expect(built.reason).toBe("scan_failed");
      }
      return;
    }

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(productionFs.supportsAnchoredHandles).toBe(true);

      await writeWatchFixture(root, "prod-a.md", "a");
      await writeWatchFixture(root, "nested/prod-b.md", "b");
      const outsideDir = await mkdtemp(join(tmpdir(), "gno-watch-prod-out-"));
      try {
        await writeFile(join(outsideDir, "secret.md"), "secret");
        await symlink(outsideDir, join(root, "link-out"), "dir");

        const built = await buildWatcherSnapshot(root, { fs: productionFs });
        expect(built.status).toBe("ok");
        if (built.status !== "ok") {
          return;
        }
        expect(built.snapshot.directories.get("")?.get("prod-a.md")?.kind).toBe(
          "file"
        );
        expect(built.snapshot.directories.get("nested")?.has("prod-b.md")).toBe(
          true
        );
        expect(built.snapshot.directories.get("")?.get("link-out")?.kind).toBe(
          "symlink"
        );
        expect(built.snapshot.directories.has("link-out")).toBe(false);

        await writeWatchFixture(root, "prod-a.md", "changed");
        const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
          fs: productionFs,
        });
        expect(diff.status).toBe("ok");
        if (diff.status !== "ok") {
          return;
        }
        expect(diff.candidates).toEqual(["prod-a.md"]);
        expect(diff.removals).toEqual([]);
      } finally {
        await safeRm(outsideDir);
      }
      return;
    }

    // Other platforms: either explicit unsupported fallback or working adapter.
    if (!productionFs.supportsAnchoredHandles) {
      const built = await buildWatcherSnapshot(root, { fs: productionFs });
      expect(built.status).toBe("fallback");
      return;
    }
    await writeWatchFixture(root, "x.md", "x");
    const built = await buildWatcherSnapshot(root, { fs: productionFs });
    expect(built.status).toBe("ok");
  });
});
