/**
 * Shared path-rule semantics for profile validation, setup preflight, and
 * ingestion. Paths use repository-relative POSIX form at this boundary.
 *
 * @module src/core/path-rules
 */

const GLOB_META_PATTERN = /[*?[\]{}]/;
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^credentials?(?:\.|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
  /\.(?:key|pem|p12|pfx)$/i,
];

export function hasLikelySecretPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function hasGlobMeta(pattern: string): boolean {
  return GLOB_META_PATTERN.test(pattern);
}

const WINDOWS_DRIVE_PREFIX_PATTERN = /^[a-z]:/i;

/**
 * Which platform's path grammar to judge a relative directory path against.
 * Injected rather than read from `process.platform` at the use site so the
 * Windows-only rules are exercised deterministically on POSIX CI.
 */
export type CollectionPathSemantics = "windows" | "posix";

function currentPathSemantics(): CollectionPathSemantics {
  return process.platform === "win32" ? "windows" : "posix";
}

/**
 * Normalize a collection-relative DIRECTORY path to the canonical POSIX form
 * used as a directory key: no leading or trailing separator, no `.` segments,
 * and the collection root as the empty string.
 *
 * Returns `null` when the path cannot be a directory inside the collection
 * root - an absolute path, a UNC prefix, a Windows drive prefix (under Windows
 * semantics), or any `..` segment. Callers must treat `null` as a refusal,
 * never as the root.
 *
 * The drive-letter rule is platform-conditional because it is not a universal
 * escape: `a:notes` and `c:stuff` are ordinary legal directory names on Linux
 * and macOS. Refusing them there is silent data loss, not safety - the watcher
 * drops the reconciliation outright and the store refuses the vanished-path
 * widening, so unreported siblings stay active and searchable forever. Absolute
 * paths, UNC prefixes (`\\server\share` normalizes to a leading `/`), and `..`
 * segments escape under BOTH grammars and stay refused unconditionally.
 *
 * The backslash-to-slash rewrite above the platform check is deliberately NOT
 * conditional, even though `weird\name` is a legal POSIX filename and gets
 * split into two segments here. It is a load-bearing part of this boundary's
 * contract: callers may hand it a Windows-form relative path on any platform
 * (the watcher rewrites separators before it ever reaches here, and
 * `test/store/active-direct-children.test.ts` pins `a\b` resolving to `a/b` on
 * every platform). Backslash-bearing POSIX directory names are therefore
 * already flattened upstream of this function and cannot be recovered by
 * changing it alone; the asymmetry with the drive rule is intentional, and the
 * harm profiles differ - over-segmenting an exotic name still reconciles
 * SOMETHING, whereas a `null` refusal reconciles nothing at all.
 */
export function normalizeCollectionDirRelPath(
  dirRelPath: string,
  semantics: CollectionPathSemantics = currentPathSemantics()
): string | null {
  const normalized = dirRelPath.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  const canonical = segments.join("/");

  // The drive check runs on the CANONICAL form, after harmless `.` segments
  // are gone. Testing the raw input instead let `./C:/foo` walk straight past
  // it and come back as the accepted `C:/foo`: the leading segment was `.`, so
  // the drive prefix was not at position 0 yet, and canonicalization then put
  // it there. Only the FIRST segment can carry a drive escape, which is exactly
  // what this form exposes.
  if (semantics === "windows" && WINDOWS_DRIVE_PREFIX_PATTERN.test(canonical)) {
    return null;
  }
  return canonical;
}

/** Drop trailing separators from an exclusion pattern (`node_modules/` -> `node_modules`). */
function stripTrailingSlashes(pattern: string): string {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === "/") {
    end -= 1;
  }
  return pattern.slice(0, end);
}

/**
 * Bare values preserve historical component/prefix semantics. Values with
 * glob metacharacters match the complete normalized relative path.
 *
 * A bare value written with a TRAILING SLASH (`node_modules/`) is the
 * directory-contents form, and it matches the strict descendants of any
 * directory named `node_modules` - not the bare path `node_modules` itself,
 * which under this spelling denotes a FILE of that name. Before this it
 * matched nothing at all: `parts.includes("node_modules/")` is never true, the
 * path is never equal to it, and `startsWith("node_modules//")` never fires,
 * so the trailing slash silently disabled the exclusion outright. That dead
 * form is also what made `exclusionCoversSubtree` unable to answer honestly for
 * it - pruning a directory is only sound when the walk would skip everything
 * under it, and nothing was being skipped.
 */
export function matchesCollectionExclusion(
  relPath: string,
  excludes: readonly string[]
): boolean {
  const normalizedPath = relPath.replaceAll("\\", "/");
  const parts = normalizedPath.split("/");

  for (const rawPattern of excludes) {
    const pattern = rawPattern.replaceAll("\\", "/");
    if (hasGlobMeta(pattern)) {
      if (new Bun.Glob(pattern).match(normalizedPath)) return true;
      continue;
    }
    if (pattern.endsWith("/")) {
      const base = stripTrailingSlashes(pattern);
      if (base === "") {
        continue;
      }
      // Every strict descendant of a directory named `base`: either `base` is
      // an anchored prefix of the path, or (single-segment form) `base` occurs
      // as a NON-FINAL component, which is the same "some ancestor directory is
      // named base" statement the bare component rule makes about the path.
      if (
        normalizedPath.startsWith(`${base}/`) ||
        (!base.includes("/") && parts.slice(0, -1).includes(base))
      ) {
        return true;
      }
      continue;
    }
    if (
      parts.includes(pattern) ||
      normalizedPath === pattern ||
      normalizedPath.startsWith(`${pattern}/`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is `prefix` (a bare, anchored path prefix) an ancestor of - or equal to -
 * the directory named by `dirParts`? Anchored: `node_modules` does NOT root
 * `a/node_modules`, because a glob is matched from the start of the path.
 */
function prefixRootsDirectory(
  dirParts: readonly string[],
  prefix: string
): boolean {
  const prefixParts = prefix.split("/");
  if (prefixParts.length > dirParts.length) {
    return false;
  }
  return prefixParts.every((segment, index) => dirParts[index] === segment);
}

/**
 * The bare prefix of a pattern whose LAST segment is `**`, or `null` when the
 * pattern is not of that shape. `**` itself yields the empty prefix.
 *
 * Every segment before the trailing `**` must be bare: `**` /`foo`/`**` is
 * rejected rather than reasoned about, which is the conservative side.
 */
function recursiveGlobPrefix(pattern: string): string | null {
  const segments = pattern.split("/");
  if (segments.at(-1) !== "**") {
    return null;
  }
  const prefixSegments = segments.slice(0, -1);
  if (
    prefixSegments.some((segment) => segment === "" || hasGlobMeta(segment))
  ) {
    return null;
  }
  return prefixSegments.join("/");
}

/**
 * Does this ONE exclusion pattern provably exclude EVERY strict descendant of
 * the directory named by `dirParts`?
 *
 * Only two syntactic shapes are accepted, and both are proven, not sampled:
 *
 * - A BARE pattern `B` (no glob metacharacters; a trailing `/` is stripped
 *   first and changes nothing about descendants) that roots the directory -
 *   `dir` is `B`, lies under `B`, or, for a single-segment `B`, contains `B` as
 *   a component. Sound because every strict descendant `dir/rest` inherits the
 *   property verbatim: if `B` is a component of `dir` it is a NON-FINAL
 *   component of `dir/rest`, and if `dir` is `B` or under `B` then `dir/rest`
 *   starts with `B/`. Both are exactly what `matchesCollectionExclusion`
 *   tests, for the bare and the `B/` spelling alike. `node_modules`, `.git`,
 *   `drafts`, `node_modules/` take this branch, so the ordinary excluded trees
 *   prune as before with no scan.
 * - A pattern whose last segment is `**` over a bare prefix `P` - `P/**`, or
 *   `**` alone - where `P` roots the directory in the ANCHORED sense. Sound
 *   because `**` matches any non-empty run of trailing segments, so every
 *   `dir/rest` (which has at least one segment beyond `P`) matches. Anchored
 *   only: `node_modules/**` says nothing about `a/node_modules/x`, so
 *   component containment is deliberately NOT applied to this shape.
 *
 * EVERY other glob is treated as non-covering, including ones that happen to
 * match some descendants. Nothing is inferred from sample paths: matching two
 * synthetic descendants does not prove the pattern matches ALL of them.
 * `foo/**` /`_[^x]*` matches a probe segment at every depth yet leaves
 * `foo/_a/x.md` indexable, and pruning `foo/_a` on that evidence strands
 * `x.md` active forever. The asymmetry is the whole argument: failing to prune
 * costs one bounded enumeration, wrongly pruning loses documents permanently.
 */
function patternCoversStrictDescendants(
  dirParts: readonly string[],
  rawPattern: string
): boolean {
  const pattern = rawPattern.replaceAll("\\", "/");
  if (pattern === "") {
    return false;
  }
  if (!hasGlobMeta(pattern)) {
    const base = stripTrailingSlashes(pattern);
    if (base === "") {
      return false;
    }
    return (
      prefixRootsDirectory(dirParts, base) ||
      (!base.includes("/") && dirParts.includes(base))
    );
  }
  const prefix = recursiveGlobPrefix(pattern);
  if (prefix === null) {
    return false;
  }
  // `**` alone: every non-empty path matches, so every descendant does.
  return prefix === "" || prefixRootsDirectory(dirParts, prefix);
}

/**
 * Does some exclusion cover the whole SUBTREE under `dirRelPath`, and not just
 * the directory's own name?
 *
 * `matchesCollectionExclusion` is a FILE-level question, and the two answers
 * genuinely differ. With `exclude: ["*.md"]` a directory literally named
 * `foo.md` matches, while `foo.md/child.txt` does not - and `FileWalker.walk`
 * indexes `child.txt`, because the walker applies the same file-level rule to
 * the file. Pruning the DIRECTORY on the file-level answer is therefore
 * strictly stricter than the walk, and the strictness is not conservative: it
 * makes the removed subtree unqueryable, so a recursive delete that reports only
 * the bare directory leaves `child.txt` active and searchable forever.
 *
 * Coverage of the STRICT DESCENDANTS is decided on its own, per pattern, by
 * `patternCoversStrictDescendants` - never gated on whether the directory
 * itself matches. The two questions are independent, and requiring the
 * directory to match first was itself a bug: `node_modules/` covers every path
 * under `node_modules` while deliberately not matching the bare path
 * `node_modules`, so the gate rejected it and boundary events did store work
 * and parent enumeration instead of being pruned.
 *
 * This never widens what is INDEXED - final file eligibility stays with
 * `matchesWalkPath`. It only stops a directory whose descendants are still
 * eligible from being pruned out of reconciliation.
 */
export function exclusionCoversSubtree(
  dirRelPath: string,
  excludes: readonly string[]
): boolean {
  const normalizedPath = stripTrailingSlashes(dirRelPath.replaceAll("\\", "/"));
  if (normalizedPath === "") {
    return false;
  }
  const dirParts = normalizedPath.split("/");
  return excludes.some((pattern) =>
    patternCoversStrictDescendants(dirParts, pattern)
  );
}
