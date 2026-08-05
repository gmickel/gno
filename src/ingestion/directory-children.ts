/**
 * Bounded, single-level enumeration of the eligible direct children of one
 * directory inside a collection.
 *
 * `FileWalker.walk` always walks recursively from the collection root and has
 * no depth bound, so the watcher's directory reconciliation needs a narrower
 * seam. Eligibility is NOT forked here: every candidate goes through the same
 * `matchesWalkPath` the watcher already applies to exact event paths.
 *
 * @module src/ingestion/directory-children
 */

// node:fs - Dirent/Stats types for the readdir and lstat calls below
import type { Dirent, Stats } from "node:fs";

// node:fs/promises - Bun has no readdir/realpath/stat equivalent (Bun.file()
// answers only for regular files, so it cannot test a DIRECTORY's existence)
import { lstat, readdir, realpath, stat } from "node:fs/promises";
// node:path - Bun has no path manipulation module
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { WalkConfig } from "./types";

import { normalizeCollectionDirRelPath } from "../core/path-rules";
import {
  checkWalkPathVisibility,
  isMissingPathError as isMissingError,
  matchesWalkPath,
  type WalkPathComponent,
} from "./walker";

/**
 * Three-state enumeration outcome.
 *
 * `missing` and `error` demand opposite caller behavior and must never collapse
 * into one empty array: a vanished directory still has to reconcile against the
 * indexed side so its children deactivate, while an unreadable directory must
 * fail closed so no deactivation is inferred from it.
 */
export type DirectoryChildrenOutcome =
  /** The directory was read; `relPaths` are the eligible direct children. */
  | { status: "present"; relPaths: string[] }
  /** The directory is genuinely gone (ENOENT / ENOTDIR). */
  | { status: "missing" }
  /**
   * The directory EXISTS but `FileWalker.walk` never enters it, so no eligible
   * file can be reached through it and nothing was read through it either.
   *
   * This is deliberately NOT `present` with an empty list. Both say "no
   * eligible children on disk", but they say different things about how much of
   * the INDEXED side is implicated. `present` means the disk WAS read, so only
   * what that read covers is answered for. `skipped` means nothing under here is
   * reachable AT ALL - a symlink at the entry point or above it puts the whole
   * SUBTREE out of the walker's reach, not merely its top level - so the caller
   * must widen its indexed side to the subtree rather than to direct children.
   *
   * Where the link POINTS makes no difference to this answer. An in-root alias
   * and one escaping the collection entirely are equally unreachable to the
   * walker, so both are `skipped` and neither is resolved. Classifying the
   * escaping one as `error` instead - "refused to read" dressed as "cannot
   * determine" - strands every document indexed under the old directory,
   * because `error` correctly infers no deactivation at all.
   *
   * What it does NOT mean is "deactivate this yourself". The no-follow policy
   * lives in `checkWalkPathVisibility` and `syncPaths` enforces it too, so paths
   * handed over from here deactivate through the ordinary batch - with its
   * generation revalidation, its chunked `markInactive`, its document-change
   * events, its scheduler notification and its typed-edge projection.
   */
  | { status: "skipped"; reason: "symlink" }
  /** The directory could not be read, or the argument was refused. */
  | { status: "error"; cause: unknown };

function toPosix(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

/**
 * `Bun.Glob.scan` - the discovery step inside `FileWalker.walk` - never yields
 * dot-prefixed names, so a full collection sync never indexes them.
 * `matchesWalkPath` cannot express this because it is deliberately
 * filesystem-free and its glob `match()` DOES accept a leading dot. Applying it
 * here keeps directory reconciliation from indexing files a full `gno update`
 * would leave out. This is walker-discovery parity, not a fork of the
 * pattern/include/exclude rules, which stay entirely with `matchesWalkPath`.
 */
function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".");
}

function escapesRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * What a reported event path turned out to be, once the disk was consulted.
 *
 * `present` is the ordinary live-edit case and carries no directory work at
 * all; `removed` names the area a vanished path implicates; `error` fails
 * closed, exactly like the enumeration outcome above.
 */
export type VanishedPathOutcome =
  /**
   * The reported path still exists: the event named the whole change.
   *
   * `isDirectory` is the leaf's NO-FOLLOW type, carried because a path that
   * exists is not automatically the same KIND of thing the index has under
   * that name. An indexed directory deleted and replaced by a regular FILE of
   * the same eligible name (`archive.md/` -> `archive.md`) is `present` here -
   * correctly, the walker can see it - while everything indexed beneath the
   * old directory is now unreachable. The caller cannot re-derive this without
   * a second stat, and only the INDEXED side can say whether the replacement
   * actually stranded anything, so the type travels with the outcome and the
   * decision stays with the caller (this module holds no store dependency).
   *
   * `true` for the collection root, which has no leaf to stat and is never a
   * replacement candidate.
   */
  | { status: "present"; isDirectory: boolean }
  /**
   * The reported path is gone. `directory` is the SHALLOWEST ancestor that is
   * also gone, or the path's own (surviving) parent directory when only the
   * file itself vanished.
   *
   * `directoryRemoved` says which of those two it is, and it is the CLASSIFICATION
   * the caller must carry forward rather than re-derive:
   *
   * - `true` - `directory` itself was OBSERVED missing on disk (including the
   *   collection root). Everything indexed beneath it, at any depth, is
   *   implicated.
   * - `false` - no ancestor of the reported path was observed missing;
   *   `directory` is its surviving parent.
   *
   * `false` is NOT the claim that the vanished path was a file. Nothing here
   * can make that claim: a directory may legitimately carry a filename-shaped
   * name, and a `*.md` collection pattern matches the directory `archive.md`
   * exactly as it matches a document. Once the path is gone the disk cannot
   * say which it was either. The caller must treat the reported path as
   * a POSSIBLE directory and discriminate on the INDEXED side - active indexed
   * descendants mean a removed subtree, none means an ordinary vanished file.
   * That decision deliberately lives with the caller: this module is
   * filesystem-only and holds no store dependency.
   *
   * A caller that re-stats `directory` later can see a RECREATED directory and
   * silently narrow a subtree removal to its direct children. The flag exists so
   * the removal intent survives that recreation.
   */
  | { status: "removed"; directory: string; directoryRemoved: boolean }
  /** The disk could not be consulted; nothing may be inferred. */
  | { status: "error"; cause: unknown };

/** Does `absPath` exist (as anything) on disk? */
async function pathExists(
  absPath: string
): Promise<boolean | { cause: unknown }> {
  try {
    await stat(absPath);
    return true;
  } catch (cause) {
    return isMissingError(cause) ? false : { cause };
  }
}

/**
 * What `walkerVisible` answers: reachable (and what KIND of thing is there),
 * gone to the walker, or unanswerable.
 */
type WalkerPresence =
  | { visible: true; isDirectory: boolean }
  | { visible: false }
  | { cause: unknown };

/**
 * Does the WALKER still see `relPath` inside `rootAbs`?
 *
 * This is the existence question the index actually cares about, and it is not
 * `stat`. A `stat` FOLLOWS, so a path that has become a symlink - or that sits
 * under one - answers "still here" while `FileWalker.walk` cannot reach it and
 * a full `gno update` deactivates everything indexed beneath it. Asking the
 * following question is precisely what stopped a directory replaced by an alias
 * from ever being widened: `archive.md -> real/` took the exact-path branch, the
 * `stat` said present, and its indexed descendants were never implicated.
 *
 * So gone-ness here means gone TO THE WALKER: absent, or unreachable no-follow.
 * Only genuine unreadability (`EACCES`, `EIO`, a hung mount) stays an error, and
 * an error still infers nothing.
 *
 * The leaf's no-follow TYPE comes back with a positive answer, at no extra
 * syscall: the visibility check already `lstat`ed every component, and the
 * caller needs the type to notice a directory that was replaced by a file.
 */
async function walkerVisible(
  rootAbs: string,
  normalizedRelPath: string
): Promise<WalkerPresence> {
  const visibility = await checkWalkPathVisibility(rootAbs, normalizedRelPath);
  if (visibility.status === "error") {
    return { cause: visibility.cause };
  }
  if (visibility.status !== "visible") {
    return { visible: false };
  }
  // `leaf` is null only for the collection root, which is a directory by
  // definition and never a replacement candidate.
  return { visible: true, isDirectory: visibility.leaf?.isDirectory() ?? true };
}

/**
 * Resolve the directory a reported event path implicates, by asking the disk
 * whether that path still exists.
 *
 * "Gone" here means gone TO THE WALKER, not absent from a following `stat` -
 * see `walkerVisible`. That distinction is what lets a directory replaced by an
 * eligible-NAMED in-root alias (`archive.md -> real/`) be widened at all: it
 * still stats fine, so the following question answered `present`, the exact-path
 * branch kept its narrow flow, and every document indexed under `archive.md/`
 * stayed active while a full `gno update` deactivated them.
 *
 * The collection ROOT is exempt from that, as it is everywhere else: it is
 * legitimately a symlink and `FileWalker.walk` resolves it, so the root's own
 * existence is still a plain following question.
 *
 * This exists because a filesystem event that names an ELIGIBLE file is not
 * automatically a complete report. Measured on Bun 1.3.14 / Linux / ext4, a
 * recursive delete of `dir1/` holding `a.md` and `b.md` reports exactly one
 * arbitrary surviving-name child (`dir1/b.md` on hardware, `dir1/a.md` in a
 * container) and nothing else - so trusting it deactivates one file and leaves
 * its siblings active forever. Bun 1.3.11 reported the directory instead. The
 * event shape is not stable across Bun patch releases; the disk is.
 *
 * - The path still exists (a live edit, the overwhelmingly common case):
 *   `present`, and the caller keeps its narrow per-path flow. This is what
 *   keeps the hot path unwidened. The leaf's no-follow TYPE rides along,
 *   because "still there" is not "still the same KIND of thing": an indexed
 *   directory replaced by a regular file of the same eligible name is present
 *   AND has stranded everything indexed beneath it. Only the indexed side can
 *   tell that apart from an ordinary file, so the type is reported and the
 *   decision stays with the caller - the mirror of the file-NAMED directory
 *   case above, in the replacement direction.
 * - The path is gone but its parent survives: `removed` with the parent, so a
 *   bounded direct-children reconciliation of that one directory runs.
 * - The path AND one or more ancestors are gone: `removed` with the shallowest
 *   removed ancestor, so the whole removed subtree can be reconciled. The
 *   reported child may be at any depth, and its parent may itself have been
 *   removed, which is why this walks rather than taking `dirname` once.
 *
 * The walk never climbs PAST the collection root - the root is the ceiling, and
 * that ceiling is what keeps a deletion from escalating into "reconcile
 * everything above the collection". But the ceiling is not the same claim as
 * "the root still exists". When the walk reaches the root it asks the disk one
 * more question:
 *
 * - the root is there (the ordinary case): `""` is the reconciled area and only
 *   its direct children are implicated;
 * - the root is genuinely ABSENT (`ENOENT`/`ENOTDIR` - the collection directory
 *   was deleted or unmounted): `""` is returned with `directoryRemoved: true`,
 *   so every document indexed under the collection deactivates. Treating the
 *   root as always surviving left exactly those documents active forever;
 * - the root could not be STATTED at all (`EACCES`, `EIO`, a hung mount): that
 *   is not evidence of absence, so it fails closed as `error` and nothing is
 *   deactivated on the strength of it.
 */
export async function resolveVanishedPathDirectory(
  relPath: string,
  root: string
): Promise<VanishedPathOutcome> {
  const normalized = normalizeCollectionDirRelPath(relPath);
  if (normalized === null || normalized === "") {
    return {
      status: "error",
      cause: new Error(`Path escapes the collection root: ${relPath}`),
    };
  }

  const rootReal = resolve(root);
  const reported = await walkerVisible(rootReal, normalized);
  if ("cause" in reported) {
    return { status: "error", cause: reported.cause };
  }
  if (reported.visible) {
    return { status: "present", isDirectory: reported.isDirectory };
  }

  let directory = parentDirectoryOf(normalized);
  while (directory !== "") {
    const exists = await walkerVisible(rootReal, directory);
    if ("cause" in exists) {
      return { status: "error", cause: exists.cause };
    }
    if (exists.visible) {
      break;
    }
    directory = parentDirectoryOf(directory);
  }

  if (directory === "") {
    // The walk stopped at the ceiling without ever proving the root is there.
    // Absence and unreadability demand opposite behavior, so ask explicitly.
    const rootPresent = await pathExists(rootReal);
    if (rootPresent !== true) {
      return rootPresent === false
        ? // The collection directory itself is gone: everything indexed under
          // it is implicated, not just the root's direct children.
          { status: "removed", directory: "", directoryRemoved: true }
        : // Unreadable, not absent - infer nothing.
          { status: "error", cause: rootPresent.cause };
    }
  }

  // `directory` now names a surviving ancestor (or the surviving root). The
  // area to reconcile is the child of it that is gone - or, when nothing above
  // the file was removed, that surviving directory itself.
  const removedChild = shallowestRemovedChild(normalized, directory);
  return {
    status: "removed",
    directory: removedChild,
    // The survivor itself is only reconciled for its direct children; anything
    // below it was observed gone.
    directoryRemoved: removedChild !== directory,
  };
}

/** The directory portion of a normalized collection-relative path. */
function parentDirectoryOf(relPath: string): string {
  const lastSlash = relPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : relPath.slice(0, lastSlash);
}

/**
 * Given the vanished path and the deepest SURVIVING ancestor directory, return
 * the directory to reconcile: the removed directory just below the survivor,
 * or the survivor itself when the vanished path was its direct child.
 */
function shallowestRemovedChild(
  vanishedRelPath: string,
  survivingDirectory: string
): string {
  if (parentDirectoryOf(vanishedRelPath) === survivingDirectory) {
    // Nothing ABOVE the reported path was observed missing, so the survivor is
    // the reconciled area. The reported path itself may still have been a
    // directory - see `VanishedPathOutcome.directoryRemoved`; that is the
    // caller's discriminator to make against the indexed side, not a question
    // this string walk can answer.
    return survivingDirectory;
  }
  const rest =
    survivingDirectory === ""
      ? vanishedRelPath
      : vanishedRelPath.slice(survivingDirectory.length + 1);
  const firstSegment = rest.slice(0, rest.indexOf("/"));
  return survivingDirectory === ""
    ? firstSegment
    : `${survivingDirectory}/${firstSegment}`;
}

/**
 * Optional seams for the enumeration below.
 *
 * `beforeReadDirectory` is awaited immediately before each `readdir`, once that
 * directory has been proven contained. It exists so the swap race the
 * traversal-time containment check DETECTS can be driven deterministically in a
 * test - replacing a directory with a symlink exactly inside the window - rather
 * than raced against a sleep. Production callers never pass it, and a hook that
 * throws is folded into the ordinary `error` outcome like any other failure, so
 * the never-throws contract holds.
 */
export interface DirectoryEnumerationHooks {
  beforeReadDirectory?: (absPath: string) => void | Promise<void>;
  /**
   * Awaited immediately before each unresolved ENTRY-PATH component is
   * `lstat`ed. It exists so the ancestor-replacement window described on
   * `checkUnresolvedEntryPath` can be driven deterministically - replacing an
   * already-verified ancestor exactly between two component checks - instead of
   * being raced against a sleep. Production callers never pass it.
   */
  beforeCheckComponent?: (absPath: string) => void | Promise<void>;
  /**
   * Awaited immediately after each `readdir`, with the entries it returned; the
   * entries it returns are the ones enumerated.
   *
   * It exists for exactly one thing: producing a `Dirent` that exposes NO type
   * at all - the `DT_UNKNOWN` every `readdir` on some network and FUSE mounts
   * returns - without requiring such a mount to be available to the test. No
   * ordinary local filesystem can be made to emit one on demand, so the
   * fallback below would otherwise be untestable. Production callers never pass
   * it.
   */
  afterReadDirectory?: (
    absPath: string,
    entries: Dirent[]
  ) => Dirent[] | Promise<Dirent[]>;
  /**
   * Awaited immediately before the fallback `lstat` of an entry whose `Dirent`
   * exposed no type. It is both the countable signal that the fallback ran at
   * all - a normally typed entry must never reach it - and the seam that drives
   * the vanish window between the `readdir` and that `lstat` deterministically.
   * Production callers never pass it.
   */
  beforeStatUnknownEntry?: (absPath: string) => void | Promise<void>;
}

/** Everything the recursion carries that is the same at every level. */
interface EnumerationContext {
  config: WalkConfig;
  recursive: boolean;
  /** The collection root, fully resolved. Containment is measured against it. */
  rootReal: string;
  out: string[];
  hooks: DirectoryEnumerationHooks | undefined;
}

/** One directory read that was proven contained at the moment it was read. */
type ContainedRead =
  | { status: "read"; entries: Dirent[] }
  /** Not a directory any more (or never was): gone, or a symlink in its place. */
  | { status: "missing" }
  | { status: "error"; cause: unknown };

/**
 * Read one directory, proving AT READ TIME that it is a real directory inside
 * the collection root - and that it was still the same directory afterwards.
 *
 * Containment established once before a walk is not containment: a directory
 * replaced by a symlink after that check but before its `readdir` is followed by
 * the `readdir`, and the files under it are then returned under
 * collection-relative names and handed to `syncPaths`, which follows the same
 * symlink and indexes content from outside the collection. A `Dirent` that said
 * "directory" is evidence about the instant the parent was listed and nothing
 * more, so descending on the strength of it has the same window.
 *
 * Three checks, in order, narrow it to what can be DETECTED - and every
 * detection fails closed. They are not a proof of atomicity: see the residual
 * window documented on `checkUnresolvedEntryPath`.
 *
 * 1. `lstat` - no-follow, so a symlink standing where a directory was is simply
 *    not a directory here. That is the SAME policy `Dirent.isDirectory()`
 *    applies to entries, so nothing changes about what is ELIGIBLE; it only
 *    stops a stale `Dirent` from being trusted after the fact.
 * 2. `realpath` + containment, immediately before the read. This is what proves
 *    every `readdir` target - not just the top one - is inside the root at the
 *    moment it is read, including when the swap happened to an ANCESTOR.
 * 3. `lstat` again after the read, comparing `(dev, ino)`. A swap landing
 *    between the containment proof and the `readdir` cannot change what that
 *    `readdir` already returned, but it can change what it returned it FROM, so
 *    the identity is re-proven and a changed inode fails the whole enumeration
 *    closed rather than reporting foreign files.
 */
async function readContainedDirectory(
  dirPath: string,
  context: EnumerationContext
): Promise<ContainedRead> {
  let before: Stats;
  try {
    before = await lstat(dirPath);
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }
  if (!before.isDirectory()) {
    return { status: "missing" };
  }

  let real: string;
  try {
    real = await realpath(dirPath);
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }
  if (escapesRoot(context.rootReal, real)) {
    return {
      status: "error",
      cause: new Error(
        `Directory path escapes the collection root: ${dirPath}`
      ),
    };
  }

  let entries: Dirent[];
  try {
    await context.hooks?.beforeReadDirectory?.(dirPath);
    entries = await readdir(dirPath, { withFileTypes: true });
    const mapped = await context.hooks?.afterReadDirectory?.(dirPath, entries);
    if (mapped) {
      entries = mapped;
    }
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }

  let after: Stats;
  try {
    after = await lstat(dirPath);
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }
  if (
    !(
      after.isDirectory() &&
      after.dev === before.dev &&
      after.ino === before.ino
    )
  ) {
    return {
      status: "error",
      cause: new Error(
        `Directory was replaced while it was being read: ${dirPath}`
      ),
    };
  }

  return { status: "read", entries };
}

/** What the UNRESOLVED entry-point path turned out to be, before any deref. */
type EntryPathCheck =
  /**
   * Every component below the root is a real directory. Enumerate it.
   *
   * `chain` carries the `(dev, ino)` each component had at the moment it was
   * verified, so the same chain can be re-proven after the read.
   */
  | { status: "walkable"; chain: WalkPathComponent[] }
  /**
   * A component below the root - the requested directory itself, or one of its
   * ancestors - is a symlink. `FileWalker.walk` never descends into one, so
   * neither may this seam.
   */
  | { status: "symlink" }
  /** A component is gone, or stands where a directory is required. */
  | { status: "missing" }
  | { status: "error"; cause: unknown };

/**
 * Prove the requested directory is reachable from the collection root WITHOUT
 * dereferencing anything on the way.
 *
 * `realpath` on the argument answers "where does this end up", which is the
 * wrong question for the entry point: it silently dereferences an in-root alias
 * (`root/alias -> root/real`), and every later check - including the read-time
 * containment proof - then sees the TARGET, so the no-follow guarantee held for
 * nested levels but not for the requested directory or its ancestors.
 *
 * The policy itself is NOT restated here. It is `checkWalkPathVisibility`, the
 * single no-follow seam beside `matchesWalkPath` that `syncPaths` also consults
 * - which is what keeps this enumeration and the sync from disagreeing about
 * what the walker can reach. That function documents the walker's measured
 * policy, the root exemption, and the non-atomic window this cannot close.
 *
 * The one thing added on top of it: the last component must be a DIRECTORY,
 * because this is a directory enumeration. Anything else standing there is the
 * same `missing` a following resolution reports as ENOTDIR.
 */
async function checkUnresolvedEntryPath(
  rootReal: string,
  normalizedDir: string,
  hooks: DirectoryEnumerationHooks | undefined
): Promise<EntryPathCheck> {
  const visibility = await checkWalkPathVisibility(rootReal, normalizedDir, {
    beforeComponent: hooks?.beforeCheckComponent,
  });
  switch (visibility.status) {
    case "symlink":
      return { status: "symlink" };
    case "missing":
      return { status: "missing" };
    case "error":
      return { status: "error", cause: visibility.cause };
    default:
      return visibility.leaf && !visibility.leaf.isDirectory()
        ? { status: "missing" }
        : { status: "walkable", chain: visibility.chain };
  }
}

/**
 * Re-prove the whole unresolved component chain after the enumeration read.
 *
 * `readContainedDirectory` re-proves the directory it READ; this re-proves how
 * that directory was REACHED. An ancestor that was swapped for a symlink after
 * its own check - the window `checkUnresolvedEntryPath` documents - is still a
 * symlink here unless the swap was undone, so the enumeration fails closed
 * instead of reporting the replacement target's files under the caller's
 * collection-relative names.
 *
 * Returns `null` when the chain is unchanged, and the terminal outcome
 * otherwise. Every failure mode is a refusal: a component that is now missing,
 * now a symlink, now a non-directory, or now a different `(dev, ino)` are all
 * "the path we walked is not the path we verified", and none of them may be
 * read as an authoritative file list.
 */
async function revalidateEntryPathChain(
  chain: WalkPathComponent[]
): Promise<DirectoryChildrenOutcome | null> {
  for (const component of chain) {
    let info: Stats;
    try {
      info = await lstat(component.absPath);
    } catch (cause) {
      return {
        status: "error",
        cause: isMissingError(cause)
          ? new Error(
              `Directory path component vanished while it was being enumerated: ${component.absPath}`
            )
          : cause,
      };
    }
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.dev !== component.dev ||
      info.ino !== component.ino
    ) {
      return {
        status: "error",
        cause: new Error(
          `Directory path component was replaced while it was being enumerated: ${component.absPath}`
        ),
      };
    }
  }
  return null;
}

/**
 * What one directory entry turned out to be, for enumeration purposes.
 *
 * `other` covers everything that is neither an eligible file nor a directory to
 * descend into - a symlink above all, but also a device, a socket, a FIFO. They
 * are all skipped, which is exactly what the `Dirent` predicates already do
 * with them.
 */
type EntryKind = "file" | "directory" | "other";

/**
 * Does this `Dirent` expose a type at all?
 *
 * `readdir(..., { withFileTypes: true })` reports the type the directory entry
 * itself carries, and on some filesystems - notably several network and FUSE
 * mounts, where a NAS- or sshfs-mounted collection is an ordinary GNO setup -
 * that type is `DT_UNKNOWN`. Every `Dirent` predicate is then false at once,
 * which is a shape no real entry has: a file is not simultaneously not-a-file,
 * not-a-directory, not-a-symlink and not a device. That impossible combination
 * is the only signal Node/Bun give that the type was never filled in, so it is
 * what the fallback keys on.
 */
function hasKnownDirentType(entry: Dirent): boolean {
  return (
    entry.isFile() ||
    entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice() ||
    entry.isFIFO() ||
    entry.isSocket()
  );
}

/** Classify a `Dirent` that DOES carry a type, without touching the disk. */
function direntKind(entry: Dirent): EntryKind {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  return "other";
}

/**
 * Classify an entry whose `Dirent` carried no type, by asking the disk.
 *
 * The fallback is `lstat`, NOT `stat`. The no-follow policy this enumeration is
 * built on has to hold here too, or the untyped case would become the one route
 * that dereferences: a symlink reached this way must be skipped exactly as a
 * `Dirent`-typed symlink is, and a symlinked DIRECTORY must not be descended
 * into - which is also what keeps the recursion loop-free. `lstat` reports the
 * link itself, so it lands in `other` and is skipped, with no second thought
 * about where it points.
 *
 * It is only ever reached for a genuinely untyped entry. A `Dirent` that
 * reports a type is classified from that `Dirent` and costs no syscall at all,
 * so filesystems that fill the type in - every ordinary local one - pay
 * nothing for this.
 *
 * This is parity, not a new policy: `Bun.Glob.scan` - the discovery step inside
 * `FileWalker.walk` - resolves its own `unknown` entry kind with an `lstatat`
 * on both Bun 1.3.11 and 1.3.14 (`src/glob/GlobWalker.zig`), so a full
 * `gno update` DOES index these files. Dropping them here is what made the two
 * disagree. The one deliberate difference is the failure arm: the walker skips
 * an entry it cannot stat for any reason, while this seam only skips a VANISHED
 * one and fails closed otherwise - the same asymmetry it already has for an
 * unreadable directory, and for the same reason (a full sync that misses files
 * indexes nothing wrong, whereas a reconciliation that misses files
 * DEACTIVATES them).
 *
 * Failures are handled the way the enclosing enumeration already handles them:
 * an `ENOENT`/`ENOTDIR` between the `readdir` and this `lstat` means the entry
 * vanished in that window, which contributes nothing and is not a failure - the
 * same answer a nested directory that vanishes mid-walk gets. Anything else
 * (`EACCES`, `EIO`, a hung mount) fails the whole enumeration closed, because a
 * partially classified directory must never be read as an authoritative file
 * list.
 */
async function classifyUnknownEntry(
  absPath: string,
  context: EnumerationContext
): Promise<
  | { status: "typed"; kind: EntryKind }
  | { status: "vanished" }
  | { status: "error"; cause: unknown }
> {
  let info: Stats;
  try {
    await context.hooks?.beforeStatUnknownEntry?.(absPath);
    info = await lstat(absPath);
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "vanished" }
      : { status: "error", cause };
  }
  if (info.isDirectory()) {
    return { status: "typed", kind: "directory" };
  }
  return { status: "typed", kind: info.isFile() ? "file" : "other" };
}

/**
 * Read one directory and collect its eligible files, descending only when
 * `context.recursive` is set.
 *
 * Returns `null` on success and a terminal outcome otherwise. A NESTED
 * directory that vanished mid-walk contributes nothing and is not an outcome:
 * only the enumerated top directory going missing means `missing`. Any other
 * failure, at any depth, fails the whole enumeration closed - the caller must
 * never read a partially readable subtree as an authoritative file list.
 *
 * Symlinks are never followed: `Dirent.isDirectory()` has `lstat` semantics, so
 * a symlinked directory is neither descended into nor listed, and
 * `readContainedDirectory` re-proves that at the moment of the read. That is
 * both parity with `FileWalker.walk` and what makes the recursion loop-free.
 * An entry that carries NO type (`DT_UNKNOWN`, ordinary on several network and
 * FUSE mounts) is classified by a no-follow `lstat` rather than dropped - see
 * `classifyUnknownEntry`, which keeps the same policy for the fallback.
 */
async function collectEligibleFiles(
  dirPath: string,
  prefix: string,
  isTop: boolean,
  context: EnumerationContext
): Promise<DirectoryChildrenOutcome | null> {
  const read = await readContainedDirectory(dirPath, context);
  if (read.status === "missing") {
    return isTop ? { status: "missing" } : null;
  }
  if (read.status === "error") {
    return { status: "error", cause: read.cause };
  }

  const subdirectories: Array<{ path: string; prefix: string }> = [];
  for (const entry of read.entries) {
    if (isHiddenSegment(entry.name)) {
      continue;
    }
    const childRelPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const childPath = join(dirPath, entry.name);

    let kind: EntryKind;
    if (hasKnownDirentType(entry)) {
      kind = direntKind(entry);
    } else {
      // `DT_UNKNOWN` - the entry has no type, so ask the disk no-follow rather
      // than dropping it. Dropping it silently omitted the replacement file an
      // atomic save leaves behind, and skipped whole untyped subdirectories in
      // the recursive path, leaving their content unindexed until a full
      // `gno update`.
      const resolved = await classifyUnknownEntry(childPath, context);
      if (resolved.status === "error") {
        return { status: "error", cause: resolved.cause };
      }
      if (resolved.status === "vanished") {
        continue;
      }
      kind = resolved.kind;
    }

    if (kind === "file") {
      if (matchesWalkPath(childRelPath, context.config)) {
        context.out.push(childRelPath);
      }
      continue;
    }
    if (context.recursive && kind === "directory") {
      subdirectories.push({ path: childPath, prefix: childRelPath });
    }
  }

  for (const subdirectory of subdirectories) {
    const failure = await collectEligibleFiles(
      subdirectory.path,
      subdirectory.prefix,
      false,
      context
    );
    if (failure) {
      return failure;
    }
  }
  return null;
}

/**
 * List the eligible direct children of `dirRelPath` inside `config.root`.
 *
 * - The collection root is `""` (also accepted as `"."` or `"/"`-padded forms).
 * - Never recurses: files in nested subdirectories are not returned.
 * - Discovery parity with `FileWalker.walk`'s `Bun.Glob.scan` step:
 *   - symlink entries are skipped entirely (`followSymlinks: false`), including
 *     symlinks resolving to a regular file inside the collection root;
 *     `Dirent.isFile()` uses `lstat` semantics, so this is exact parity - and
 *     an entry whose `Dirent` carries no type at all (`DT_UNKNOWN`, which some
 *     network and FUSE mounts return for every entry) is resolved by a
 *     no-follow `lstat` rather than silently omitted, so the same parity holds
 *     there;
 *   - the REQUESTED directory and its ancestors get the same treatment: a
 *     symlink anywhere below the root is not walked into, so an in-root alias
 *     reports `skipped` rather than the target's files;
 *   - dot-prefixed entries and dot-prefixed directories are skipped.
 *   Eligibility itself is never forked - it stays with `matchesWalkPath`.
 * - Containment is proven at READ time, not once before the read - see
 *   `readContainedDirectory` - and the unresolved component chain is re-proven
 *   after the read (`revalidateEntryPathChain`). Every DETECTED change fails
 *   closed; the residual window, and why it cannot be closed on this runtime,
 *   are documented on `checkUnresolvedEntryPath`.
 * - `maxBytes` is deliberately NOT enforced here. `matchesWalkPath` is
 *   filesystem-free and the watcher's existing exact-path filter is equally
 *   size-blind; `syncPaths` owns size enforcement, and statting every candidate
 *   before handing paths to it would only duplicate that work.
 * - Never throws: every failure is reported as `missing` or `error`.
 */
export function listEligibleDirectChildren(
  dirRelPath: string,
  config: WalkConfig,
  hooks?: DirectoryEnumerationHooks
): Promise<DirectoryChildrenOutcome> {
  return enumerateEligible(dirRelPath, config, false, hooks);
}

/**
 * List every eligible file anywhere beneath `dirRelPath` inside `config.root`.
 *
 * Same seam, same eligibility, same containment and discovery parity as
 * `listEligibleDirectChildren` - it only descends.
 *
 * This exists for exactly one case: a directory whose REMOVAL was already
 * established when the event was classified, and which EXISTS again by the time
 * the flush enumerates it (an editor that rewrites a tree, a checkout, a
 * restore). The removal intent is carried on the queue so the indexed side
 * still answers for the whole subtree, but a direct-children disk read then
 * describes only the top level of the recreated tree, so a file written into a
 * recreated NESTED directory appears in neither half of the union and stays
 * unindexed - indefinitely on Linux, where writes inside a directory created
 * after the watch began emit no events at all (bun#15939).
 *
 * It stays bounded: rooted at that one directory, never at the collection,
 * eligibility-filtered per candidate, contained by a realpath check re-proven at
 * every level AS it descends (`readContainedDirectory`), and symlink-free so it
 * cannot walk out of the subtree or loop. It costs disk
 * reads only - one `readdir` per recreated subdirectory - and adds no store
 * round trips at all.
 */
export function listEligibleSubtreeFiles(
  dirRelPath: string,
  config: WalkConfig,
  hooks?: DirectoryEnumerationHooks
): Promise<DirectoryChildrenOutcome> {
  return enumerateEligible(dirRelPath, config, true, hooks);
}

async function enumerateEligible(
  dirRelPath: string,
  config: WalkConfig,
  recursive: boolean,
  hooks: DirectoryEnumerationHooks | undefined
): Promise<DirectoryChildrenOutcome> {
  const normalizedDir = normalizeCollectionDirRelPath(dirRelPath);
  if (normalizedDir === null) {
    return {
      status: "error",
      cause: new Error(
        `Directory path escapes the collection root: ${dirRelPath}`
      ),
    };
  }

  let rootReal: string;
  try {
    rootReal = await realpath(resolve(config.root));
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }

  const dirAbs =
    normalizedDir === "" ? rootReal : resolve(rootReal, normalizedDir);

  // The entry point and its ancestors are examined NO-FOLLOW first, so a
  // symlink standing anywhere below the root is never dereferenced into an
  // enumeration.
  const entryCheck = await checkUnresolvedEntryPath(
    rootReal,
    normalizedDir,
    hooks
  );
  if (entryCheck.status === "missing") {
    return { status: "missing" };
  }
  if (entryCheck.status === "error") {
    return { status: "error", cause: entryCheck.cause };
  }

  if (entryCheck.status === "symlink") {
    // A symlink stands at the entry point or above it (`root/alias ->
    // root/real`, or `root/alias -> /somewhere/else`). `FileWalker.walk` skips a
    // symlinked directory outright, so a full sync indexes nothing under
    // `alias/...`. What is NOT allowed is what the realpath-first version did:
    // enumerate the TARGET and report its files under the alias' names.
    //
    // Answered here, BEFORE the argument is resolved, and deliberately WITHOUT
    // consulting where the link points. Resolving first classified an ESCAPING
    // link (a directory replaced by a symlink to a tree outside the collection)
    // as an enumeration `error`, and an error is fail-closed: the reconciliation
    // produces no candidates at all, so every document indexed under the old
    // directory stays active even though a full no-follow walk removes them all.
    // "Refused to read" must not masquerade as "cannot determine". Containment
    // is not weakened by answering earlier - the point of the policy is that
    // nothing is ever read THROUGH the link, and nothing is: the target is not
    // even resolved. Genuine unreadable/IO failures (`EACCES`, `EIO`) are
    // reported by `checkUnresolvedEntryPath` above and keep the `error` path.
    //
    // Reported as `skipped`, not as an empty `present`, because the two imply
    // different WIDTHS of indexed side: an alias at or above the entry point
    // makes the whole subtree unreachable, so direct children are not enough.
    // The deactivation itself is not this module's business - `syncPaths`
    // enforces the same `checkWalkPathVisibility` policy and marks these paths
    // inactive through the ordinary batch. See `DirectoryChildrenOutcome`.
    return { status: "skipped", reason: "symlink" };
  }

  let dirReal: string;
  try {
    dirReal = await realpath(dirAbs);
  } catch (cause) {
    return isMissingError(cause)
      ? { status: "missing" }
      : { status: "error", cause };
  }

  // No component below the root was a symlink a moment ago, so this resolution
  // should be the identity. It is kept as the ARGUMENT check - it says the
  // requested path was contained when it was resolved, which is why it can
  // report the caller's `dirRelPath` - and it still catches a component swapped
  // for an escaping link between the no-follow check and here. It is NOT what
  // keeps the traversal contained; every directory actually read is re-proven
  // contained at read time by `readContainedDirectory`.
  if (escapesRoot(rootReal, dirReal)) {
    return {
      status: "error",
      cause: new Error(
        `Directory path escapes the collection root: ${dirRelPath}`
      ),
    };
  }

  // No component below the root is a symlink, so the unresolved path IS the
  // canonical one - and it is the path used from here on, so nothing that
  // appears after this point can be reached through a dereferenced entry point.
  const prefix = toPosix(relative(rootReal, dirAbs));
  if (prefix.split("/").some(isHiddenSegment)) {
    // A dot-prefixed directory is never walked, so it has no eligible children.
    return { status: "present", relPaths: [] };
  }

  const relPaths: string[] = [];
  const failure = await collectEligibleFiles(dirAbs, prefix, true, {
    config,
    recursive,
    rootReal,
    out: relPaths,
    hooks,
  });
  if (failure) {
    return failure;
  }

  // The chain that was verified BEFORE the read is re-proven AFTER it, so an
  // ancestor swapped for a symlink mid-traversal cannot pass its files off as
  // this directory's. Bounded by path depth and run once per enumeration.
  const changed = await revalidateEntryPathChain(entryCheck.chain);
  if (changed) {
    return changed;
  }

  relPaths.sort((a, b) => a.localeCompare(b));
  return { status: "present", relPaths };
}
