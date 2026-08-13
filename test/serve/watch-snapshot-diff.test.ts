/**
 * Core build/diff selection for watcher hierarchical snapshots (gno-27 task .1).
 *
 * Generic snapshot tests inject a path-backed adapter so they are platform-
 * independent (Windows production default intentionally falls back).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WatcherSnapshotFs } from "../../src/serve/watch-snapshot";

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

describe("buildWatcherSnapshot + diffWatcherSnapshot", () => {
  let root = "";
  let fs: WatcherSnapshotFs;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-watch-snap-"));
    fs = createRealPathBackedWatcherFs();
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("unchanged dirty directory yields no candidates and preserves fingerprints", async () => {
    await writeWatchFixture(root, "a.md", "one");
    await writeWatchFixture(root, "b.md", "two");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.entryCount).toBe(built.snapshot.entryCount);
  });

  test("added, changed, and removed files are selected", async () => {
    await writeWatchFixture(root, "keep.md", "k");
    await writeWatchFixture(root, "gone.md", "g");
    await writeWatchFixture(root, "edit.md", "old");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await writeWatchFixture(root, "new.md", "n");
    await writeWatchFixture(root, "edit.md", "new-body");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "gone.md"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["edit.md", "new.md"]);
    expect(diff.removals).toEqual(["gone.md"]);
  });

  test("nested change does not select untouched siblings", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeWatchFixture(root, "root.md", "r");
    await writeWatchFixture(root, "sub/keep.md", "k");
    await writeWatchFixture(root, "sub/edit.md", "old");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await writeWatchFixture(root, "sub/edit.md", "new");

    const diff = await diffWatcherSnapshot(root, built.snapshot, ["sub"], {
      fs,
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["sub/edit.md"]);
    expect(diff.removals).toEqual([]);
  });

  test("removed directory expands prior nested files from the snapshot", async () => {
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
    // Proven snapshot advances only after successful classification.
    expect(diff.nextSnapshot.directories.has("tree")).toBe(false);
    expect(diff.nextSnapshot.directories.has("tree/deep")).toBe(false);
  });

  test("file→directory replacement proves old source removable and scans descendants", async () => {
    await writeWatchFixture(root, "record.json", '{"a":1}');
    await writeWatchFixture(root, "keep.md", "k");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    expect(built.snapshot.directories.get("")?.get("record.json")?.kind).toBe(
      "file"
    );

    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "record.json"));
    await mkdir(join(root, "record.json"), { recursive: true });
    await writeWatchFixture(root, "record.json/child.md", "nested");
    await writeWatchFixture(root, "record.json/deep/x.md", "deep");

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    // Old file/source path is an explicit removal (stale index must drop it).
    expect(diff.removals).toEqual(["record.json"]);
    // New directory descendants are present candidates, not the dir itself.
    expect(diff.candidates).toEqual([
      "record.json/child.md",
      "record.json/deep/x.md",
    ]);
    expect(
      diff.nextSnapshot.directories.get("")?.get("record.json")?.kind
    ).toBe("directory");
    expect(
      diff.nextSnapshot.directories.get("record.json")?.has("child.md")
    ).toBe(true);
  });

  test("record-container source→directory is explicitly removable", async () => {
    // Logical record-container source path is a normal file path in the snapshot
    // (e.g. notes.json). Replacement by a directory must surface that source in
    // removals without calling store/ingestion from this primitive.
    await writeWatchFixture(root, "notes.json", '{"records":[]}');
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "notes.json"));
    await mkdir(join(root, "notes.json"));
    await writeWatchFixture(root, "notes.json/item.md", "i");

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toContain("notes.json");
    expect(diff.candidates).toContain("notes.json/item.md");
    expect(diff.candidates).not.toContain("notes.json");
  });

  test("directory→file replacement expands prior nested removals and candidates the file", async () => {
    await mkdir(join(root, "was-dir", "nested"), { recursive: true });
    await writeWatchFixture(root, "was-dir/a.md", "a");
    await writeWatchFixture(root, "was-dir/nested/b.md", "b");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "was-dir"));
    await writeWatchFixture(root, "was-dir", "now-a-file");

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual(["was-dir/a.md", "was-dir/nested/b.md"]);
    expect(diff.candidates).toEqual(["was-dir"]);
    expect(diff.nextSnapshot.directories.get("")?.get("was-dir")?.kind).toBe(
      "file"
    );
    expect(diff.nextSnapshot.directories.has("was-dir")).toBe(false);
  });

  test("atomic replacement changes inode/ctime and selects the path", async () => {
    await writeWatchFixture(root, "note.md", "v1");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const { rename, unlink } = await import("node:fs/promises");
    const tmp = join(root, "note.md.tmp");
    await writeFile(tmp, "v2");
    await unlink(join(root, "note.md"));
    await rename(tmp, join(root, "note.md"));

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["note.md"]);
    expect(diff.removals).toEqual([]);
  });

  test("nearest surviving ancestor for a missing nested hint", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeWatchFixture(root, "a/b/c.md", "c");
    await writeWatchFixture(root, "a/sibling.md", "s");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    await safeRm(join(root, "a", "b"));

    const resolved = await resolveWatcherDirtyDirectory(root, "a/b/c.md", {
      fs,
    });
    expect(resolved).toEqual({ status: "ok", directory: "a" });

    const reconciled = await reconcileWatcherHints(
      root,
      built.snapshot,
      ["a/b/c.md"],
      { fs }
    );
    expect(reconciled.status).toBe("ok");
    if (reconciled.status !== "ok") {
      return;
    }
    expect(reconciled.removals).toContain("a/b/c.md");
    expect(reconciled.candidates).not.toContain("a/sibling.md");
    expect(reconciled.removals).not.toContain("a/sibling.md");
  });

  test("new-directory hint records parent edge and cleans up on missing child hint", async () => {
    await writeWatchFixture(root, "sibling.md", "s");
    await mkdir(join(root, "other"), { recursive: true });
    await writeWatchFixture(root, "other/keep.md", "k");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    const baselineCount = built.snapshot.entryCount;

    await mkdir(join(root, "new-dir"), { recursive: true });
    await writeWatchFixture(root, "new-dir/child.md", "c");

    // Reconcile only the new directory hint (not the parent root).
    const added = await reconcileWatcherHints(
      root,
      built.snapshot,
      ["new-dir"],
      { fs }
    );
    expect(added.status).toBe("ok");
    if (added.status !== "ok") {
      return;
    }
    // Parent edge for new-dir must exist; no orphan map without parent edge.
    expect(added.nextSnapshot.directories.get("")?.get("new-dir")?.kind).toBe(
      "directory"
    );
    expect(added.nextSnapshot.directories.get("new-dir")?.has("child.md")).toBe(
      true
    );
    // root: sibling.md, other/, new-dir/ (+ other/keep, new-dir/child) = baseline + 2
    expect(added.nextSnapshot.entryCount).toBe(baselineCount + 2);
    expect(added.candidates).toEqual(["new-dir/child.md"]);
    expect(added.removals).toEqual([]);
    // Sibling tree untouched.
    expect(added.nextSnapshot.directories.get("")?.has("sibling.md")).toBe(
      true
    );
    expect(added.nextSnapshot.directories.get("other")?.has("keep.md")).toBe(
      true
    );

    await safeRm(join(root, "new-dir"));

    // Missing nested hint climbs to nearest surviving ancestor (root) and
    // removes the subtree via the recorded parent edge.
    const removed = await reconcileWatcherHints(
      root,
      added.nextSnapshot,
      ["new-dir/child.md"],
      { fs }
    );
    expect(removed.status).toBe("ok");
    if (removed.status !== "ok") {
      return;
    }
    expect(removed.removals).toEqual(["new-dir/child.md"]);
    expect(removed.nextSnapshot.directories.has("new-dir")).toBe(false);
    expect(removed.nextSnapshot.directories.get("")?.has("new-dir")).toBe(
      false
    );
    expect(removed.nextSnapshot.directories.get("")?.has("sibling.md")).toBe(
      true
    );
    expect(removed.nextSnapshot.directories.get("other")?.has("keep.md")).toBe(
      true
    );
    expect(removed.candidates).not.toContain("sibling.md");
    expect(removed.removals).not.toContain("other/keep.md");
    expect(removed.nextSnapshot.entryCount).toBe(baselineCount);
  });

  test("observed-then-missing child after readdir is scan_failed, not silent deletion", async () => {
    await writeWatchFixture(root, "keep.md", "k");
    await writeWatchFixture(root, "gone.md", "g");

    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const raceFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: (abs) => fs.openDir(abs),
      readDir: async (_handle, maxNames) => {
        const names = ["gone.md", "keep.md"];
        if (names.length > maxNames) {
          return { status: "overflow" };
        }
        return { status: "ok", names };
      },
      lstatChild: async (handle, name) => {
        if (name === "gone.md") {
          throw Object.assign(new Error("ENOENT race"), { code: "ENOENT" });
        }
        return fs.lstatChild(handle, name);
      },
      openChildDir: (handle, name) => fs.openChildDir(handle, name),
      closeDir: (handle) => fs.closeDir(handle),
    };

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: raceFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
    // No candidates, removals, or nextSnapshot on fallback — previous proven.
    expect("candidates" in diff).toBe(false);
    expect("removals" in diff).toBe(false);
    expect("nextSnapshot" in diff).toBe(false);
    expect(built.snapshot.directories.get("")?.has("gone.md")).toBe(true);
    expect(built.snapshot.directories.get("")?.has("keep.md")).toBe(true);
  });

  test("observed-then-ENOTDIR child after readdir is scan_failed, not snapshot advance", async () => {
    await writeWatchFixture(root, "source.md", "s");
    const built = await buildWatcherSnapshot(root, { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    const raceFs: WatcherSnapshotFs = {
      supportsAnchoredHandles: true,
      openDir: (abs) => fs.openDir(abs),
      // Child still listed, but lstat reports path replacement race (ENOTDIR).
      readDir: async (_handle, maxNames) => {
        const names = ["source.md"];
        if (names.length > maxNames) {
          return { status: "overflow" };
        }
        return { status: "ok", names };
      },
      lstatChild: async (_handle, name) => {
        if (name === "source.md") {
          throw Object.assign(new Error("ENOTDIR race"), { code: "ENOTDIR" });
        }
        throw Object.assign(new Error("unexpected"), { code: "ENOENT" });
      },
      openChildDir: (handle, name) => fs.openChildDir(handle, name),
      closeDir: (handle) => fs.closeDir(handle),
    };

    const diff = await diffWatcherSnapshot(root, built.snapshot, [""], {
      fs: raceFs,
    });
    expect(diff.status).toBe("fallback");
    if (diff.status !== "fallback") {
      return;
    }
    expect(diff.reason).toBe("scan_failed");
    expect("removals" in diff).toBe(false);
    expect("nextSnapshot" in diff).toBe(false);
    expect(built.snapshot.directories.get("")?.has("source.md")).toBe(true);
  });
});
