import { describe, expect, test } from "bun:test";

import type { CollectionPathSemantics } from "../../src/core/path-rules";

import {
  exclusionCoversSubtree,
  matchesCollectionExclusion,
  normalizeCollectionDirRelPath,
} from "../../src/core/path-rules";

const BOTH: CollectionPathSemantics[] = ["posix", "windows"];

describe("normalizeCollectionDirRelPath", () => {
  test("canonicalizes ordinary relative directory paths under both grammars", () => {
    for (const semantics of BOTH) {
      expect(normalizeCollectionDirRelPath("a/b", semantics)).toBe("a/b");
      expect(normalizeCollectionDirRelPath("./a/b/", semantics)).toBe("a/b");
      expect(normalizeCollectionDirRelPath("a\\b", semantics)).toBe("a/b");
      expect(normalizeCollectionDirRelPath(".", semantics)).toBe("");
      expect(normalizeCollectionDirRelPath("", semantics)).toBe("");
    }
  });

  test("accepts POSIX-legal drive-shaped directory names under posix semantics", () => {
    expect(normalizeCollectionDirRelPath("a:notes", "posix")).toBe("a:notes");
    expect(normalizeCollectionDirRelPath("c:stuff/deep", "posix")).toBe(
      "c:stuff/deep"
    );
    expect(normalizeCollectionDirRelPath("a:", "posix")).toBe("a:");
    expect(normalizeCollectionDirRelPath("./C:/foo", "posix")).toBe("C:/foo");
  });

  test("refuses Windows drive prefixes under windows semantics", () => {
    expect(normalizeCollectionDirRelPath("C:/foo", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath("C:\\foo", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath("c:stuff", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath("a:notes", "windows")).toBeNull();
  });

  test("refuses a drive prefix hidden behind leading dot segments", () => {
    // The drive check must run on the CANONICAL form. Testing the raw input
    // let a leading `.` segment push the drive letter off position 0, and
    // canonicalization then handed the caller back the accepted `C:/foo` - the
    // exact escape the windows rule exists to refuse, reachable by prefixing
    // two characters.
    expect(normalizeCollectionDirRelPath("./C:/foo", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath(".\\C:\\foo", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath("././c:stuff", "windows")).toBeNull();
    expect(normalizeCollectionDirRelPath("./a:", "windows")).toBeNull();
    // Only the FIRST segment can carry the escape: a drive-shaped name deeper
    // in the path is an ordinary directory name and stays accepted, as before.
    expect(normalizeCollectionDirRelPath("./notes/C:/foo", "windows")).toBe(
      "notes/C:/foo"
    );
  });

  test("refuses absolute paths, UNC prefixes, and traversal under both grammars", () => {
    for (const semantics of BOTH) {
      expect(normalizeCollectionDirRelPath("/etc", semantics)).toBeNull();
      expect(normalizeCollectionDirRelPath("/", semantics)).toBeNull();
      expect(
        normalizeCollectionDirRelPath("\\\\server\\share", semantics)
      ).toBeNull();
      expect(
        normalizeCollectionDirRelPath("//server/share", semantics)
      ).toBeNull();
      expect(normalizeCollectionDirRelPath("..", semantics)).toBeNull();
      expect(normalizeCollectionDirRelPath("../", semantics)).toBeNull();
      expect(normalizeCollectionDirRelPath("a/../..", semantics)).toBeNull();
      expect(normalizeCollectionDirRelPath("a/..\\b", semantics)).toBeNull();
    }
  });

  test("defaults to the running platform's grammar when semantics are omitted", () => {
    const expected =
      process.platform === "win32"
        ? normalizeCollectionDirRelPath("a:notes", "windows")
        : normalizeCollectionDirRelPath("a:notes", "posix");

    expect(normalizeCollectionDirRelPath("a:notes")).toBe(expected);
  });
});

/**
 * `exclusionCoversSubtree` is the DIRECTORY-level question, and it is
 * deliberately narrower than the file-level `matchesCollectionExclusion`.
 * Pruning a directory on the file-level answer is stricter than the walk: with
 * `exclude: ["*.md"]` the walker still indexes `foo.md/child.txt`, so a pruned
 * `foo.md` makes a removed subtree unqueryable and strands `child.txt` active.
 *
 * The whole function is new at 538e3047, so every case here is discriminating
 * by construction (it does not compile against the base). What each case pins
 * is which SIDE of the rule a pattern lands on.
 */
describe("exclusionCoversSubtree", () => {
  test("covers the subtree for bare component/prefix patterns", () => {
    // Bare patterns match as a path COMPONENT or as a `pattern/` prefix, and
    // both reach every descendant - so pruning stays exactly as strict as it
    // was for the ordinary excluded trees, and the amplification bound holds.
    for (const dir of ["node_modules", "a/node_modules", "node_modules/pkg"]) {
      expect(matchesCollectionExclusion(dir, ["node_modules"])).toBe(true);
      expect(exclusionCoversSubtree(dir, ["node_modules"])).toBe(true);
    }
    expect(exclusionCoversSubtree("drafts", ["drafts"])).toBe(true);
    expect(exclusionCoversSubtree("archive/old", ["archive"])).toBe(true);
  });

  test("does NOT cover the subtree for a glob matching only the directory name", () => {
    // The finding: `*.md` matches the directory `foo.md` but says nothing about
    // `foo.md/child.txt`, which the walker still indexes.
    expect(matchesCollectionExclusion("foo.md", ["*.md"])).toBe(true);
    expect(exclusionCoversSubtree("foo.md", ["*.md"])).toBe(false);
    expect(matchesCollectionExclusion("logs.log", ["*.log"])).toBe(true);
    expect(exclusionCoversSubtree("logs.log", ["*.log"])).toBe(false);
    // A single `*` matches one segment only, so descendants stay walkable.
    expect(exclusionCoversSubtree("anything", ["*"])).toBe(false);
  });

  test("covers the subtree for a glob that matches at every depth", () => {
    // `**` matches every non-empty path, so it covers every descendant of
    // every directory - the one glob shape that needs no prefix at all.
    expect(exclusionCoversSubtree("anything", ["**"])).toBe(true);
    expect(exclusionCoversSubtree("a/b", ["**"])).toBe(true);
  });

  test("covers the subtree for a trailing `**` over a bare prefix", () => {
    // `P/**` matches any non-empty run of segments below `P`, so it covers
    // every strict descendant of `P` and of anything under `P`.
    expect(exclusionCoversSubtree("node_modules", ["node_modules/**"])).toBe(
      true
    );
    expect(
      exclusionCoversSubtree("node_modules/pkg", ["node_modules/**"])
    ).toBe(true);
    // Anchored, not component-matched: a glob is matched from the start of the
    // path, so `node_modules/**` says nothing about `a/node_modules/x`.
    expect(exclusionCoversSubtree("a/node_modules", ["node_modules/**"])).toBe(
      false
    );
    // A non-bare prefix is refused rather than reasoned about.
    expect(
      exclusionCoversSubtree("a/node_modules", ["**/node_modules/**"])
    ).toBe(false);
  });

  /**
   * Finding A. The previous rule ASKED the glob about two synthetic descendant
   * paths and inferred universal coverage from the two answers. Matching two
   * samples is not a proof: `foo/**` + `/_[^x]*` matches a probe segment at
   * every depth (the probe name starts with `_`), so `foo/_a` was reported as
   * covered and pruned - while `foo/_a/x.md` does NOT match the exclusion and
   * is indexed by the walker, so it stayed active with nothing behind it.
   *
   * Discriminating against b4950b13: there `exclusionCoversSubtree("foo/_a",
   * ["foo/**\/_[^x]*"])` is `true`.
   */
  test("does NOT infer coverage from descendant samples", () => {
    const exclude = ["foo/**/_[^x]*"];
    // The directory itself matches, and so does any deeper `_`-prefixed name.
    expect(matchesCollectionExclusion("foo/_a", exclude)).toBe(true);
    // But this descendant does not - the walker indexes it.
    expect(matchesCollectionExclusion("foo/_a/x.md", exclude)).toBe(false);
    expect(exclusionCoversSubtree("foo/_a", exclude)).toBe(false);
    // Same shape without the character class, and `dir/*`, which stops at one
    // level and leaves `dir/a/b.txt` walkable.
    expect(exclusionCoversSubtree("_a", ["**/_*"])).toBe(false);
    expect(exclusionCoversSubtree("dir", ["dir/*"])).toBe(false);
  });

  /**
   * Finding B. Strict-descendant coverage is decided on its own; it is not
   * gated on the directory's own path matching. `node_modules/` is the
   * directory-contents spelling: it covers everything under `node_modules`
   * while deliberately not matching the bare path `node_modules`, which under
   * that spelling denotes a file of that name.
   *
   * Discriminating against b4950b13 on both halves: there the trailing slash
   * made the pattern match NOTHING (so the exclusion was silently dead and the
   * coverage gate returned false), and boundary events did store work and
   * parent enumeration instead of being pruned.
   */
  test("covers the subtree for an exact-root `node_modules/` exclusion", () => {
    const exclude = ["node_modules/"];
    // The file-level rule is what makes pruning sound: every strict descendant
    // really is skipped by the walk.
    expect(
      matchesCollectionExclusion("node_modules/pkg/readme.md", exclude)
    ).toBe(true);
    expect(matchesCollectionExclusion("a/node_modules/pkg.md", exclude)).toBe(
      true
    );
    // ...and the bare path itself is NOT matched, which is exactly why
    // coverage may not be gated on it.
    expect(matchesCollectionExclusion("node_modules", exclude)).toBe(false);

    for (const dir of ["node_modules", "a/node_modules", "node_modules/pkg"]) {
      expect(exclusionCoversSubtree(dir, exclude)).toBe(true);
    }
    expect(exclusionCoversSubtree("notes", exclude)).toBe(false);
  });

  test("ignores patterns that do not match the directory at all", () => {
    expect(exclusionCoversSubtree("notes", ["node_modules"])).toBe(false);
    expect(exclusionCoversSubtree("notes", [])).toBe(false);
    // The collection root is never pruned.
    expect(exclusionCoversSubtree("", ["**"])).toBe(false);
  });

  test("takes the covering pattern when several exclusions match", () => {
    // `*.md` alone would not cover it, but `foo.md` (bare) does, and one
    // covering pattern is enough.
    expect(exclusionCoversSubtree("foo.md", ["*.md", "foo.md"])).toBe(true);
    expect(exclusionCoversSubtree("foo.md", ["*.md", "other"])).toBe(false);
  });
});
