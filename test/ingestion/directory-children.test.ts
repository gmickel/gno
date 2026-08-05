import type { Dirent } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DirectoryEnumerationHooks } from "../../src/ingestion/directory-children";
import type { WalkConfig } from "../../src/ingestion/types";

import {
  listEligibleDirectChildren,
  listEligibleSubtreeFiles,
  resolveVanishedPathDirectory,
} from "../../src/ingestion/directory-children";
import { FileWalker } from "../../src/ingestion/walker";
import { safeRm } from "../helpers/cleanup";

function walkConfig(root: string, overrides: Partial<WalkConfig> = {}) {
  return {
    root,
    pattern: "**/*",
    include: [],
    additionalDefaultExtensions: [],
    exclude: [],
    maxBytes: 10_000_000,
    ...overrides,
  } satisfies WalkConfig;
}

describe("listEligibleDirectChildren", () => {
  let base = "";
  let root = "";

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "gno-dir-children-"));
    root = join(base, "root");
    await mkdir(root);
  });

  afterEach(async () => {
    await safeRm(base);
  });

  test("returns eligible direct children of the collection root", async () => {
    await writeFile(join(root, "note.md"), "a");
    await writeFile(join(root, "other.md"), "b");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "nested.md"), "c");

    const outcome = await listEligibleDirectChildren("", walkConfig(root));

    expect(outcome).toEqual({
      status: "present",
      relPaths: ["note.md", "other.md"],
    });
  });

  test("accepts '.' and slash-padded forms as the collection root", async () => {
    await writeFile(join(root, "note.md"), "a");

    for (const dir of [".", "./", ""]) {
      expect(await listEligibleDirectChildren(dir, walkConfig(root))).toEqual({
        status: "present",
        relPaths: ["note.md"],
      });
    }
  });

  test("returns eligible direct children of a nested directory", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "top.md"), "a");
    await writeFile(join(root, "a", "b", "deep.md"), "b");
    await writeFile(join(root, "rootlevel.md"), "c");

    expect(await listEligibleDirectChildren("a", walkConfig(root))).toEqual({
      status: "present",
      relPaths: ["a/top.md"],
    });

    expect(await listEligibleDirectChildren("a/b/", walkConfig(root))).toEqual({
      status: "present",
      relPaths: ["a/b/deep.md"],
    });
  });

  test("does not recurse into nested subdirectories", async () => {
    await mkdir(join(root, "deep", "deeper"), { recursive: true });
    await writeFile(join(root, "deep", "deeper", "hidden-away.md"), "a");

    expect(await listEligibleDirectChildren("deep", walkConfig(root))).toEqual({
      status: "present",
      relPaths: [],
    });
  });

  test("applies include, exclude, and pattern rules via matchesWalkPath", async () => {
    await writeFile(join(root, "keep.md"), "a");
    await writeFile(join(root, "skip.txt"), "b");
    await writeFile(join(root, "excluded.md"), "c");

    const outcome = await listEligibleDirectChildren(
      "",
      walkConfig(root, { include: [".md"], exclude: ["excluded.md"] })
    );

    expect(outcome).toEqual({ status: "present", relPaths: ["keep.md"] });
  });

  test("respects a narrowing glob pattern", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "in.md"), "a");
    await writeFile(join(root, "out.md"), "b");

    expect(
      await listEligibleDirectChildren(
        "",
        walkConfig(root, { pattern: "docs/**/*" })
      )
    ).toEqual({ status: "present", relPaths: [] });

    expect(
      await listEligibleDirectChildren(
        "docs",
        walkConfig(root, { pattern: "docs/**/*" })
      )
    ).toEqual({ status: "present", relPaths: ["docs/in.md"] });
  });

  test("excludes dotfiles and reserved virtual record paths", async () => {
    await writeFile(join(root, "visible.md"), "a");
    await writeFile(join(root, ".hidden.md"), "b");
    await mkdir(join(root, ".dotdir"));
    await writeFile(join(root, ".dotdir", "inner.md"), "d");
    await mkdir(join(root, ".gno", "records"), { recursive: true });
    await writeFile(join(root, ".gno", "records", "fake.md"), "c");

    expect(await listEligibleDirectChildren("", walkConfig(root))).toEqual({
      status: "present",
      relPaths: ["visible.md"],
    });
    expect(
      await listEligibleDirectChildren(".dotdir", walkConfig(root))
    ).toEqual({ status: "present", relPaths: [] });
    expect(
      await listEligibleDirectChildren(".gno/records", walkConfig(root))
    ).toEqual({ status: "present", relPaths: [] });

    // Parity gate: reconciliation must not surface anything a full collection
    // walk would refuse to index.
    const walked = await new FileWalker().walk(walkConfig(root));
    expect(walked.entries.map((entry) => entry.relPath)).toEqual([
      "visible.md",
    ]);
  });

  test("returns missing for a vanished directory", async () => {
    expect(await listEligibleDirectChildren("gone", walkConfig(root))).toEqual({
      status: "missing",
    });
  });

  test("returns missing when the target path is a file, not a directory", async () => {
    await writeFile(join(root, "file.md"), "a");

    expect(
      await listEligibleDirectChildren("file.md", walkConfig(root))
    ).toEqual({ status: "missing" });
  });

  test("returns missing when the collection root itself is gone", async () => {
    expect(
      await listEligibleDirectChildren(
        "",
        walkConfig(join(base, "no-such-root"))
      )
    ).toEqual({ status: "missing" });
  });

  test("returns error with cause for an unreadable directory", async () => {
    const locked = join(root, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "note.md"), "a");
    await chmod(locked, 0o000);

    try {
      const outcome = await listEligibleDirectChildren(
        "locked",
        walkConfig(root)
      );
      // Running as root defeats permission bits; only assert when it took hold.
      if (outcome.status === "present") {
        return;
      }
      expect(outcome.status).toBe("error");
      const { cause } = outcome as { cause: { code?: string } };
      expect(cause).toBeDefined();
      expect(cause.code).toBe("EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("refuses a directory argument that escapes the collection root", async () => {
    await writeFile(join(base, "outside.md"), "a");

    for (const dir of ["..", "../", "a/../..", "/etc"]) {
      const outcome = await listEligibleDirectChildren(dir, walkConfig(root));
      expect(outcome.status).toBe("error");
      expect(String((outcome as { cause: unknown }).cause)).toContain(
        "escapes the collection root"
      );
    }
  });

  test("reconciles a POSIX-legal drive-shaped directory name", async () => {
    // `a:notes` is a legal directory name on Linux/macOS. Classifying it as an
    // escape would drop its reconciliation entirely.
    if (process.platform === "win32") {
      return;
    }
    await mkdir(join(root, "a:notes"));
    await writeFile(join(root, "a:notes", "note.md"), "a");

    expect(
      await listEligibleDirectChildren("a:notes", walkConfig(root))
    ).toEqual({
      status: "present",
      relPaths: ["a:notes/note.md"],
    });
  });

  /**
   * A symlinked entry point is `skipped` WHEREVER it points.
   *
   * The escaping case used to be classified by resolving the link first, which
   * made it an enumeration `error` - and `error` is fail-closed, so the
   * reconciliation produced no candidates and every document indexed under the
   * replaced directory stayed active, while a full no-follow walk removes them
   * all. "Refused to read" must not masquerade as "cannot determine".
   *
   * Containment is not weakened by answering earlier, and the second assertion
   * is what says so: the target is never read, and never even resolved.
   *
   * Against 538e3047 the first assertion fails (`{status: "error"}` naming
   * "escapes the collection root"). Discriminating, not a direction pin.
   */
  test("reports a symlink to a directory OUTSIDE the collection as skipped", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "far.md"), "a");
    await symlink(outside, join(root, "linkdir"), "dir");

    const reads: string[] = [];
    const outcome = await listEligibleDirectChildren(
      "linkdir",
      walkConfig(root),
      {
        beforeReadDirectory: (absPath) => {
          reads.push(absPath);
        },
      }
    );

    expect(outcome).toEqual({ status: "skipped", reason: "symlink" });
    expect(reads).toEqual([]);
    // The walker agrees: it never descends into the link, so nothing under
    // `linkdir/` is indexed by a full sync either.
    expect(
      (await new FileWalker().walk(walkConfig(root))).entries.map(
        (entry) => entry.relPath
      )
    ).toEqual([]);
  });

  /**
   * The `error` path is NOT softened generally: a directory that exists and is
   * genuinely unreadable still fails closed, so no deactivation is inferred
   * from it. Only the provably-symlink case became `skipped`. The unreadable
   * case is pinned by "returns error with cause for an unreadable directory"
   * above; this one pins that an unreadable path does not become `skipped` by
   * some other route.
   */
  test.skipIf(process.getuid?.() === 0)(
    "keeps an unreadable directory on the error path, never skipped",
    async () => {
      const locked = join(root, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "note.md"), "a");
      await chmod(locked, 0o000);

      try {
        const outcome = await listEligibleDirectChildren(
          "locked",
          walkConfig(root)
        );
        expect(outcome.status).toBe("error");
      } finally {
        await chmod(locked, 0o755);
      }
    }
  );

  /**
   * The entry point itself must not be dereferenced.
   *
   * Canonicalizing the argument before the no-follow check made the guarantee
   * hold for every NESTED level and for nothing else: an in-root alias
   * (`root/alias -> root/real`) was resolved first, so both identity checks saw
   * the target and the alias' children were enumerated - under names the walker
   * never produces. Against the pre-fix code this returns
   * `["real/note.md"]` and reads `root/real`; both assertions below are
   * discriminating, neither only pins direction.
   */
  test("does not dereference a symlinked entry point", async () => {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "note.md"), "a");
    await symlink(join(root, "real"), join(root, "alias"), "dir");

    const reads: string[] = [];
    const outcome = await listEligibleDirectChildren(
      "alias",
      walkConfig(root),
      {
        beforeReadDirectory: (absPath) => {
          reads.push(absPath);
        },
      }
    );

    const walked = (await new FileWalker().walk(walkConfig(root))).entries
      .map((entry) => entry.relPath)
      .sort();

    // FileWalker.walk skips the symlinked directory outright, so nothing is
    // indexed under `alias/` by a full sync...
    expect(walked).toEqual(["real/note.md"]);
    // ...and this seam reports the same, having read nothing through it.
    // `skipped`, not an empty `present`: the caller must DEACTIVATE what it has
    // indexed under here rather than reconcile it by following the path.
    expect(outcome).toEqual({ status: "skipped", reason: "symlink" });
    expect(reads).toEqual([]);
  });

  /**
   * The entry point is not the only thing that can be aliased. `alias/sub` has
   * a real directory at its last component and a symlink ABOVE it, and the
   * walker never reaches it either, so the same no-follow answer is owed.
   *
   * Against the pre-fix code this returned `{present, []}`, which is what let
   * an indexed `alias/sub/note.md` reach `syncPaths`, be followed and stay
   * active. Discriminating on the status, not a direction pin.
   */
  test("reports a directory reached through a symlinked ANCESTOR as skipped", async () => {
    await mkdir(join(root, "real", "sub"), { recursive: true });
    await writeFile(join(root, "real", "sub", "note.md"), "a");
    await symlink(join(root, "real"), join(root, "alias"), "dir");

    const reads: string[] = [];
    const outcome = await listEligibleDirectChildren(
      "alias/sub",
      walkConfig(root),
      {
        beforeReadDirectory: (absPath) => {
          reads.push(absPath);
        },
      }
    );

    expect(outcome).toEqual({ status: "skipped", reason: "symlink" });
    expect(reads).toEqual([]);
  });

  test("never throws for a bogus glob pattern", async () => {
    await writeFile(join(root, "note.md"), "a");

    const outcome = await listEligibleDirectChildren(
      "",
      walkConfig(root, { pattern: "[" })
    );

    expect(outcome).toEqual({ status: "present", relPaths: [] });
  });

  test("symlink handling matches FileWalker.walk", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "far.md"), "x");
    await writeFile(join(root, "real.md"), "a");
    await symlink(join(root, "real.md"), join(root, "link-inside.md"));
    await symlink(join(outside, "far.md"), join(root, "link-outside.md"));
    await symlink(join(base, "nope.md"), join(root, "broken.md"));

    const walked = await new FileWalker().walk(walkConfig(root));
    const walkedRootChildren = walked.entries
      .map((entry) => entry.relPath)
      .filter((relPath) => !relPath.includes("/"))
      .sort();

    const outcome = await listEligibleDirectChildren("", walkConfig(root));

    // FileWalker scans with followSymlinks:false, so no symlink entry is
    // returned - not even one resolving to a regular file inside the root.
    expect(walkedRootChildren).toEqual(["real.md"]);
    expect(outcome).toEqual({ status: "present", relPaths: ["real.md"] });
  });
});

/**
 * The recursive form used for a directory carrying REMOVAL INTENT that turned
 * out to exist again. Same eligibility, same discovery parity, same
 * containment - it only descends.
 */
describe("listEligibleSubtreeFiles", () => {
  let base = "";
  let root = "";

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "gno-dir-subtree-"));
    root = join(base, "root");
    await mkdir(root);
  });

  afterEach(async () => {
    await safeRm(base);
  });

  test("returns eligible files at every depth beneath the directory", async () => {
    await mkdir(join(root, "dir1", "sub", "deeper"), { recursive: true });
    await writeFile(join(root, "dir1", "top.md"), "a");
    await writeFile(join(root, "dir1", "sub", "mid.md"), "b");
    await writeFile(join(root, "dir1", "sub", "deeper", "deep.md"), "c");
    // Outside the enumerated directory: bounded means bounded.
    await writeFile(join(root, "outside.md"), "d");

    expect(await listEligibleSubtreeFiles("dir1", walkConfig(root))).toEqual({
      status: "present",
      relPaths: ["dir1/sub/deeper/deep.md", "dir1/sub/mid.md", "dir1/top.md"],
    });
  });

  test("keeps walker discovery parity while descending", async () => {
    await mkdir(join(root, "dir1", ".hidden"), { recursive: true });
    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", ".hidden", "secret.md"), "a");
    await writeFile(join(root, "dir1", "sub", ".dotfile.md"), "b");
    await writeFile(join(root, "dir1", "sub", "kept.md"), "c");
    await writeFile(join(root, "escape.md"), "d");
    // A symlinked directory is neither descended into nor listed, which is both
    // walker parity and what makes the recursion loop-free.
    await symlink(root, join(root, "dir1", "loop"), "dir");

    expect(await listEligibleSubtreeFiles("dir1", walkConfig(root))).toEqual({
      status: "present",
      relPaths: ["dir1/sub/kept.md"],
    });
  });

  /**
   * The same defect one level up: `alias/sub` names a real directory through a
   * symlinked ANCESTOR. Pre-fix the whole argument was canonicalized, so the
   * ancestor was dereferenced silently and this returned
   * `["real/sub/note.md"]` after reading `root/real/sub` - discriminating on
   * both the outcome and the read log.
   */
  test("does not dereference a symlinked ancestor of the entry point", async () => {
    await mkdir(join(root, "real", "sub"), { recursive: true });
    await writeFile(join(root, "real", "sub", "note.md"), "a");
    await symlink(join(root, "real"), join(root, "alias"), "dir");

    const reads: string[] = [];
    const outcome = await listEligibleSubtreeFiles(
      "alias/sub",
      walkConfig(root),
      {
        beforeReadDirectory: (absPath) => {
          reads.push(absPath);
        },
      }
    );

    expect(outcome).toEqual({ status: "skipped", reason: "symlink" });
    expect(reads).toEqual([]);
  });

  test("reports a genuinely absent directory as missing", async () => {
    expect(await listEligibleSubtreeFiles("gone", walkConfig(root))).toEqual({
      status: "missing",
    });
  });

  /**
   * Containment checked once before the walk is not containment. These drive
   * the swap through the `beforeReadDirectory` seam - no sleeps, no racing -
   * so the replacement lands exactly in the window between "this directory was
   * proven contained" and "this directory is read".
   *
   * Against the pre-fix code both of these enumerate the OUTSIDE tree and
   * return its files under collection-relative names, which `syncPaths` then
   * follows and indexes. Both are discriminating, not direction pins.
   */
  test("refuses a nested directory swapped for an external symlink mid-walk", async () => {
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "leak");

    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", "top.md"), "a");
    await writeFile(join(root, "dir1", "sub", "inner.md"), "b");

    // The enumeration descends through the REALPATH of the root (`/tmp` is a
    // symlink on macOS), so the seam reports resolved paths.
    const swapTarget = join(await realpath(root), "dir1", "sub");
    let swapped = false;
    const outcome = await listEligibleSubtreeFiles("dir1", walkConfig(root), {
      beforeReadDirectory: async (absPath) => {
        // The `Dirent` for `sub` already said "directory" and `sub` has already
        // been proven contained; replace it in exactly that window.
        if (absPath === swapTarget && !swapped) {
          swapped = true;
          await safeRm(swapTarget);
          await symlink(outside, swapTarget, "dir");
        }
      },
    });

    expect(swapped).toBe(true);
    expect(outcome.status).toBe("error");
    // Nothing from outside the collection root is reported under a
    // collection-relative name, at any status.
    expect(JSON.stringify(outcome)).not.toContain("secret.md");
  });

  test("refuses when an ancestor of the read directory is swapped mid-walk", async () => {
    const outside = join(base, "outside");
    await mkdir(join(outside, "sub"), { recursive: true });
    await writeFile(join(outside, "sub", "secret.md"), "leak");

    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", "sub", "inner.md"), "a");

    const rootReal = await realpath(root);
    const ancestor = join(rootReal, "dir1");
    const nested = join(rootReal, "dir1", "sub");
    const outcome = await listEligibleSubtreeFiles("dir1", walkConfig(root), {
      beforeReadDirectory: async (absPath) => {
        // `dir1` was proven contained and listed; swapping the ANCESTOR then
        // makes the already-queued descent into `dir1/sub` resolve outside the
        // root. The containment proof must be re-taken for THIS read.
        if (absPath === nested) {
          await safeRm(ancestor);
          await symlink(outside, ancestor, "dir");
        }
      },
    });

    expect(outcome.status).toBe("error");
    expect(JSON.stringify(outcome)).not.toContain("secret.md");
  });

  /**
   * The ENTRY-PATH component chain is checked one `lstat` at a time, so it is
   * not atomic: `a` can be renamed away and replaced by a symlink after `a` has
   * been verified and before `a/b` is checked, and that later `lstat` then
   * traverses the replacement. This drives exactly that window through the
   * `beforeCheckComponent` seam - no sleeps, no racing.
   *
   * The replacement points INSIDE the collection root on purpose, so the
   * containment check cannot be what refuses it: what refuses it is the
   * post-read re-proof of the component chain's `(dev, ino)`.
   *
   * This pins CURRENT behavior after the tightening (fail closed), and it is
   * discriminating: without the chain re-proof the enumeration returns
   * `present` with the replacement target's file under `a/b/...`. It is NOT a
   * claim of atomicity - a swap that is UNDONE before the re-check, or one that
   * preserves `(dev, ino)`, is still not detected, and cannot be on this
   * runtime (see `checkUnresolvedEntryPath`).
   */
  test("refuses when an ancestor is replaced between component checks", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "own.md"), "a");
    await mkdir(join(root, "impostor", "b"), { recursive: true });
    await writeFile(join(root, "impostor", "b", "planted.md"), "b");

    const rootReal = await realpath(root);
    const ancestor = join(rootReal, "a");
    let replaced = false;
    const outcome = await listEligibleSubtreeFiles("a/b", walkConfig(root), {
      beforeCheckComponent: async (absPath) => {
        // `a` has been verified; the NEXT component check is about to run.
        if (absPath === join(rootReal, "a", "b") && !replaced) {
          replaced = true;
          await safeRm(ancestor);
          await symlink(join(rootReal, "impostor"), ancestor, "dir");
        }
      },
    });

    expect(replaced).toBe(true);
    expect(outcome.status).toBe("error");
    expect(String((outcome as { cause: unknown }).cause)).toContain(
      "was replaced while it was being enumerated"
    );
    // The impostor's file is never reported under `a/b/...`.
    expect(JSON.stringify(outcome)).not.toContain("planted.md");
  });

  test("applies the collection's eligibility rules to nested candidates", async () => {
    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", "sub", "kept.md"), "a");
    await writeFile(join(root, "dir1", "sub", "image.png"), "b");

    expect(
      await listEligibleSubtreeFiles(
        "dir1",
        walkConfig(root, { pattern: "**/*.md" })
      )
    ).toEqual({ status: "present", relPaths: ["dir1/sub/kept.md"] });
  });
});

/**
 * `readdir(..., { withFileTypes: true })` does not always know what an entry
 * is. Several network and FUSE mounts - a NAS- or sshfs-mounted collection is
 * an ordinary GNO setup, not an exotic one - return `DT_UNKNOWN` for every
 * entry, and a `Dirent` carrying that type answers `false` to `isFile()` AND
 * `isDirectory()` at once.
 *
 * Against 433e7d4b such an entry matched neither branch of the collect loop and
 * was silently omitted: direct reconciliation missed the replacement file an
 * atomic save leaves behind, and the recursive path skipped whole
 * subdirectories, leaving their content unindexed until a full `gno update`.
 *
 * No local filesystem can be made to emit `DT_UNKNOWN` on demand, so the type
 * is blanked through the `afterReadDirectory` seam rather than by requiring a
 * FUSE mount; the DISK below the blanked entry is real, which is what the
 * fallback `lstat` reads.
 */
describe("entries whose Dirent carries no type (DT_UNKNOWN)", () => {
  let base = "";
  let root = "";

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "gno-dir-unknown-"));
    root = join(base, "root");
    await mkdir(root);
  });

  afterEach(async () => {
    await safeRm(base);
  });

  /** The same entry, with every type predicate answering false. */
  function untyped(entry: Dirent): Dirent {
    const no = () => false;
    return {
      name: entry.name,
      parentPath: entry.parentPath,
      path: entry.parentPath,
      isFile: no,
      isDirectory: no,
      isSymbolicLink: no,
      isBlockDevice: no,
      isCharacterDevice: no,
      isFIFO: no,
      isSocket: no,
    } as unknown as Dirent;
  }

  /** Blank the type of the named entries, wherever they are read. */
  function blankTypes(names: string[]): DirectoryEnumerationHooks {
    return {
      afterReadDirectory: (_absPath, entries) =>
        entries.map((entry) =>
          names.includes(entry.name) ? untyped(entry) : entry
        ),
    };
  }

  /**
   * Discriminating against 433e7d4b: there the untyped `note.md` matched
   * neither branch and the result was `{present, []}`.
   */
  test("includes an untyped entry that is an eligible file", async () => {
    await writeFile(join(root, "note.md"), "a");
    await writeFile(join(root, "image.png"), "b");

    expect(
      await listEligibleDirectChildren(
        "",
        walkConfig(root, { pattern: "**/*.md" }),
        blankTypes(["note.md", "image.png"])
      )
    ).toEqual({ status: "present", relPaths: ["note.md"] });
  });

  /**
   * Discriminating against 433e7d4b: the untyped `sub` was not pushed onto the
   * descent list, so `dir1/sub/inner.md` never appeared and the recursive
   * enumeration returned `["dir1/top.md"]` alone.
   */
  test("descends into an untyped entry that is a directory", async () => {
    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", "top.md"), "a");
    await writeFile(join(root, "dir1", "sub", "inner.md"), "b");

    expect(
      await listEligibleSubtreeFiles(
        "dir1",
        walkConfig(root),
        blankTypes(["sub"])
      )
    ).toEqual({
      status: "present",
      relPaths: ["dir1/sub/inner.md", "dir1/top.md"],
    });
  });

  /**
   * The no-follow policy holds for the fallback too. A following `stat` would
   * classify these as a plain file and a plain directory and index content the
   * walker never reaches - which is the whole reason the fallback is `lstat`.
   *
   * Not a direction pin: against a `stat`-based fallback the first assertion
   * gains `link.md` and the second gains `linkdir/far.md`. Against 433e7d4b it
   * passes for the wrong reason (everything untyped was dropped), so the
   * file/directory tests above are what discriminate there.
   */
  test("still skips an untyped entry that is really a symlink", async () => {
    const outside = join(base, "outside");
    await mkdir(join(outside, "deep"), { recursive: true });
    await writeFile(join(outside, "target.md"), "x");
    await writeFile(join(outside, "deep", "far.md"), "y");

    await writeFile(join(root, "real.md"), "a");
    await symlink(join(outside, "target.md"), join(root, "link.md"));
    await symlink(join(outside, "deep"), join(root, "linkdir"), "dir");

    const hooks = blankTypes(["link.md", "linkdir"]);

    expect(
      await listEligibleDirectChildren("", walkConfig(root), hooks)
    ).toEqual({ status: "present", relPaths: ["real.md"] });
    // The recursive path does not descend through it either.
    expect(await listEligibleSubtreeFiles("", walkConfig(root), hooks)).toEqual(
      {
        status: "present",
        relPaths: ["real.md"],
      }
    );
    // ...and the walker agrees: a full sync indexes neither.
    expect(
      (await new FileWalker().walk(walkConfig(root))).entries
        .map((entry) => entry.relPath)
        .sort()
    ).toEqual(["real.md"]);
  });

  /**
   * The fallback is a second syscall, so the entry can be gone by the time it
   * runs - exactly the atomic-save window this seam exists for. That is not a
   * failure: the entry contributes nothing and its siblings are still an
   * authoritative list, the same answer a nested directory that vanishes
   * mid-walk already gets.
   *
   * Discriminating on the status against a fallback that let ENOENT reach the
   * generic error path: that returns `{status: "error"}` and the whole
   * reconciliation produces no candidates at all.
   */
  test("an entry that vanishes before the fallback stat contributes nothing", async () => {
    await writeFile(join(root, "gone.md"), "a");
    await writeFile(join(root, "stays.md"), "b");

    const rootReal = await realpath(root);
    let statted = "";
    const outcome = await listEligibleDirectChildren("", walkConfig(root), {
      ...blankTypes(["gone.md"]),
      beforeStatUnknownEntry: async (absPath) => {
        statted = absPath;
        await safeRm(absPath);
      },
    });

    expect(statted).toBe(join(rootReal, "gone.md"));
    expect(outcome).toEqual({ status: "present", relPaths: ["stays.md"] });
  });

  /**
   * The fallback is paid for ONLY when the type is genuinely unknown. Every
   * ordinary local filesystem fills the type in, so this asserts the normal
   * path costs no extra syscall at all - including for the entries that are
   * skipped anyway (a symlink, a directory in the non-recursive case).
   */
  test("a normally typed Dirent costs no fallback stat", async () => {
    await mkdir(join(root, "dir1", "sub"), { recursive: true });
    await writeFile(join(root, "dir1", "top.md"), "a");
    await writeFile(join(root, "dir1", "sub", "inner.md"), "b");
    await symlink(join(root, "dir1", "top.md"), join(root, "dir1", "link.md"));

    const statted: string[] = [];
    const hooks: DirectoryEnumerationHooks = {
      beforeStatUnknownEntry: (absPath) => {
        statted.push(absPath);
      },
    };

    expect(
      await listEligibleDirectChildren("dir1", walkConfig(root), hooks)
    ).toEqual({ status: "present", relPaths: ["dir1/top.md"] });
    expect(
      await listEligibleSubtreeFiles("dir1", walkConfig(root), hooks)
    ).toEqual({
      status: "present",
      relPaths: ["dir1/sub/inner.md", "dir1/top.md"],
    });
    expect(statted).toEqual([]);
  });
});

/**
 * The collection root is the CEILING of the ancestor walk, which is what keeps
 * a deletion from escalating above the collection. It is not a claim that the
 * root still exists - and conflating the two left every document under a
 * deleted collection root active forever.
 */
describe("resolveVanishedPathDirectory collection-root handling", () => {
  let base = "";
  let root = "";

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "gno-vanished-root-"));
    root = join(base, "root");
    await mkdir(root);
  });

  afterEach(async () => {
    await chmod(base, 0o700).catch(() => undefined);
    await safeRm(base);
  });

  test("a surviving root reconciles only its own direct children", async () => {
    const outcome = await resolveVanishedPathDirectory("gone.md", root);

    // Nothing above the file went anywhere, so there is no subtree to widen to.
    expect(outcome).toEqual({
      status: "removed",
      directory: "",
      directoryRemoved: false,
    });
  });

  test("a surviving path reports what KIND of thing now stands there", async () => {
    // "Still here" is not "still the same thing". An indexed directory
    // rewritten as a document of the same eligible name is present to the
    // walker while everything indexed beneath it has been stranded, so the
    // leaf's no-follow type travels with the outcome for the caller to
    // discriminate on the indexed side.
    await Bun.write(join(root, "file.md"), "# file\n");
    await mkdir(join(root, "dir.md"));

    expect(await resolveVanishedPathDirectory("file.md", root)).toEqual({
      status: "present",
      isDirectory: false,
    });
    expect(await resolveVanishedPathDirectory("dir.md", root)).toEqual({
      status: "present",
      isDirectory: true,
    });
  });

  test("a removed ancestor is reported as removed, not as a surviving parent", async () => {
    const outcome = await resolveVanishedPathDirectory("dir1/sub/c.md", root);

    expect(outcome).toEqual({
      status: "removed",
      directory: "dir1",
      directoryRemoved: true,
    });
  });

  test("widens a vanished child of a drive-shaped POSIX directory name", async () => {
    // Pre-fix this path was refused as an escape, so a delete under `a:notes`
    // never widened and its siblings stayed active.
    if (process.platform === "win32") {
      return;
    }
    await mkdir(join(root, "a:notes"));

    const outcome = await resolveVanishedPathDirectory("a:notes/gone.md", root);

    expect(outcome).toEqual({
      status: "removed",
      directory: "a:notes",
      directoryRemoved: false,
    });
  });

  test("an ABSENT collection root marks the root itself removed", async () => {
    await safeRm(root);

    const outcome = await resolveVanishedPathDirectory("dir1/a.md", root);

    // The whole collection directory went, so the area to reconcile is the
    // root AND everything indexed beneath it - not `dir1` alone, and not
    // "the root survived" as before.
    expect(outcome).toEqual({
      status: "removed",
      directory: "",
      directoryRemoved: true,
    });
  });

  test("an absent root is still the root for a root-level file", async () => {
    await safeRm(root);

    const outcome = await resolveVanishedPathDirectory("top.md", root);

    expect(outcome).toEqual({
      status: "removed",
      directory: "",
      directoryRemoved: true,
    });
  });

  test.skipIf(process.getuid?.() === 0)(
    "an UNSTATTABLE root fails closed instead of claiming a removal",
    async () => {
      // The root is unreadable, not gone: `stat` fails with EACCES rather than
      // ENOENT. A transient/permission failure must never be read as absence,
      // because absence is what deactivates documents.
      await chmod(base, 0o000);

      const outcome = await resolveVanishedPathDirectory("dir1/a.md", root);

      expect(outcome.status).toBe("error");
      expect((outcome as { cause?: { code?: string } }).cause?.code).toBe(
        "EACCES"
      );
    }
  );
});
