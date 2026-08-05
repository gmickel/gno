# Reliable watcher reconciliation for atomic writes and deletions

## Overview

Continuous indexing in `gno serve` / `gno daemon` silently misses documents written by
atomic savers. `src/serve/watch-service.ts:203-212` treats the filename reported by
recursive `node:fs.watch` as authoritative: if the reported relative path fails
`matchesWalkPath` (`src/ingestion/walker.ts:187`), the event is dropped and
`syncPaths` never sees the directory. An atomic writer creates `.hermes-tmp.<id>`
and renames it to `final.md`; on Linux, Bun forwards only the source (temp) name
(oven-sh/bun#36328), so the final `*.md` is never presented for ingestion and stays
invisible until a manual `gno update`.

The fix reclassifies filesystem events as **hints about a changed area**. Exact
eligible paths keep the existing per-path incremental flow untouched. Ambiguous
paths mark their **parent directory** dirty; at flush time the watcher reconciles the
union of (a) eligible direct children on disk and (b) active indexed documents that
are direct children of the same directory, then hands the deduplicated relative
paths to the existing `defaultSyncService.syncPaths`, which already stats each path,
ingests material changes, and marks missing paths inactive
(`src/ingestion/sync.ts:1218-1267`).

This is a watcher-correctness bug fix. It is not a second indexing daemon, a timer
fallback, or an ingestion rewrite.

## Verified production evidence

Environment: GNO 1.30.1, Bun on Linux, `gno serve` running continuously.

1. The status endpoint reported the configured collections as actively watched.
2. The process had active inotify descriptors and recursive watches.
3. A normal `cp` of an eligible Markdown file into a watched collection became
   retrievable without `gno update` in approximately 2.5 seconds.
4. An atomic writer created `.hermes-tmp.<id>` in the destination directory and
   renamed it to `final.md`.
5. A standalone recursive Bun `fs.watch` observed only the temporary path for that
   write sequence; it did not report the final Markdown path.
6. GNO did not index the resulting eligible Markdown file within repeated 45-second
   probes, including after restarting `gno serve`.
7. Deleting an indexed eligible probe advanced watcher sync state, but the document
   remained retrievable until a full `gno update` marked it inactive.
8. `gno update` successfully reconciled both missed additions and stale deletions,
   proving that full collection ingestion is correct enough to repair the index.

The hidden-file probe is not evidence of a defect by itself: dotfiles may
intentionally be excluded. The ordinary Markdown and copy probes establish the
relevant contrast.

Upstream corroboration found during planning:

- **oven-sh/bun#36328** — on Linux, `IN_MOVED_FROM`/`IN_MOVED_TO` arrive in one kernel
  batch but Bun forwards only the source name, so atomic saves never report the
  destination filename. This is the proven root cause of evidence item 5/6.
- **oven-sh/bun#33110** — watcher queue overflow now surfaces as `('change', null)`.
- **oven-sh/bun#15939** — recursive watch on Linux can miss files created inside a
  newly created subdirectory.
- **oven-sh/bun#33396** — recursive watch leaked inotify descriptors on directories
  moved out of the tree (fixed upstream; confirm against the pinned Bun in
  `package.json`, `bun >=1.3.0`).

## Measured watcher behavior (task `.1`, Bun 1.3.11)

Captured from a real recursive `fs.watch` on linux 6.10.14 (tmpfs-backed container, genuine
inotify) and cross-checked on darwin 25.5.0. Every `eventType` was `rename` on both
platforms; **no `null` filename was ever observed**.

| scenario | linux reports | darwin reports |
|---|---|---|
| direct create | `direct.md` | `direct.md` |
| atomic save, plain temp (`note.md.tmp` → `note.md`) | `note.md.tmp` only | both |
| atomic save, dot temp (`.gno-tmp.x` → `hidden.md`) | `hidden.md` only | both |
| atomic replace, nested | `nested/note.md.tmp` only | all three |
| single-file delete | `direct.md` | `direct.md` |
| recursive directory delete (`dir1` holding `a.md`, `b.md`) | `dir1` only | children + `dir1` |
| write into a subdirectory created after watch start | **nothing** | `post/d.md` |
| case-only rename | `foo.md` | both |

This measurement corrects three assumptions the plan was originally written on:

1. **bun#36328 is real and unfixed** for plain temp names — the destination is never
   reported. The core premise stands.
2. **Bun's Linux recursive watcher never reports dot-prefixed names at all.** For a
   dot-prefixed temp the source is filtered out and only the destination survives, which
   the existing code already handles. The ambiguity is real only for **non-dot** temp
   names. This directly contradicts production evidence item 5, which observed only the
   `.hermes-tmp.<id>` path — see Open questions.
3. **The deletion defect is not a single-file delete.** A single-file delete names the
   deleted file on both platforms, which is why the pre-existing green deletion test
   passes and why the live failure was never reproducible from it. The real stale-active
   condition is a **recursive directory delete** reporting only the directory.

### Bun 1.3.14 divergence (post-review, reporter's Linux VPS + container)

The shapes above are **not stable across Bun patch releases**. Re-captured on the
the reporter's own Linux VPS running GNO (Bun 1.3.14, kernel 7.0.0-27-generic, ext4, real
inotify, not a container) and reproduced in a `tmpfs` container on the same version:

| scenario | Bun 1.3.11 / linux | Bun 1.3.14 / linux |
|---|---|---|
| recursive directory delete (`dir1` holding `a.md`, `b.md`) | `dir1` only | **one arbitrary child only** — `dir1/b.md` on hardware, `dir1/a.md` in the container |
| atomic save, dot temp (`.gno-tmp.x` → `hidden.md`) | destination only | **the dot temp source** (`.gno-tmp.abc123`) |
| write into a subdirectory created after watch start | nothing | `post/d.md` (bun#15939 appears fixed) |

The recursive-delete change is the defect this corrective commit fixes, and the
important property is that **which child is named is arbitrary** — it is not the
first, not the last, and it differed between hardware and container on the same
Bun version. Because the named child is an ELIGIBLE path, it took the exact-path
fast path, so no reconciliation ran and every unnamed sibling stayed active
indefinitely (confirmed live: `a.md` disappeared from `POST /api/search` while
`b.md` was still retrievable 30s later).

The consequence for the design: "ineligible ⇒ hint / eligible ⇒ authoritative"
is wrong for deletions. A deletion event naming an eligible path is provably not
a complete report. Correctness is therefore conditioned on the DISK — a reported
path that no longer exists is one sample of a larger removal — rather than on
any event shape, which is the only formulation that survives a patch release.

Two further platform defects were measured and are constraints on task `.3`, not
requirements of it:

- **Post-watch subdirectories are invisible on Linux** (confirms bun#15939). Writes into a
  directory created after the watch began produce no events whatsoever, and writes into a
  *renamed* pre-existing directory are reported under the stale pre-rename path. No
  event means no hint, so reconciliation cannot help; this stays a documented limitation.
- **Events collapse per watcher read batch.** A ~5 ms separation is enough to split them;
  300 rapid writes delivered 20 events. Coalescing assertions in `.3` must therefore
  measure reconciliation batches, never delivered event counts.

## Current implementation and root-cause boundary

### Proven atomic-write failure

`src/serve/watch-service.ts` currently:

1. receives `eventType` and `filename` from recursive `node:fs.watch`
   (`:197-220`, one watcher per collection created in `updateCollections` `:127-232`);
2. converts `filename` to a POSIX collection-relative path (`:199`);
3. immediately applies `matchesWalkPath` with `collectionToWalkConfig(currentCollection, 0)`
   (`:203-212`);
4. returns without queueing when the reported path is ineligible;
5. checks `#suppressedPaths` (`:214-217`) and only then calls `#queueChange`
   (`:278-297`, 300 ms debounce), which flushes through `#flushCollection`
   (`:299-435`) into `syncPaths` (`:348-356`).

For an atomic save where Bun reports only `.hermes-tmp.<id>`, step 4 rejects the
path, so the final `*.md` never reaches `syncPaths`.

This is a generic mismatch between event shape and final filesystem state. The fix
must not special-case Hermes or any particular temporary filename.

### Deletion root cause is not yet proven

`syncPaths` already handles a known missing eligible path by marking active
documents inactive (`src/ingestion/sync.ts:1218-1267`), and
`test/serve/watch-service.test.ts:550-595` contains green deletion coverage.
`matchesWalkPath` is deliberately filesystem-free (`walker.ts:182-186`) so a
deleted `deleted.md` still passes eligibility. Therefore the observed live deletion
failure must not be attributed to `markInactive` without a failing reproduction.

Likely causes include Linux event shape (a delete that surfaces only as a rename of
a temp name, or as a directory-level event), path normalization, event coalescing,
directory-level rename semantics, or a difference between the existing fake-watcher
test and real Bun behavior. Task `.1` must capture the real event sequence and
produce a RED regression before product code changes.

## Approach

### Exact-path fast path (unchanged)

When the reported relative path is eligible under the **current** collection
configuration:

- preserve the existing debounce and `syncPaths` path;
- preserve suppression semantics (`#suppressedPaths`, keyed by absolute path);
- do not enumerate the directory;
- emit/schedule only when ingestion reports a material add or update
  (`changedPaths`, `watch-service.ts:72-85`).

### Bounded reconciliation path (new)

When an event cannot safely identify the final eligible path, queue the smallest
trustworthy area as dirty, in a structure parallel to the existing
`#pendingByCollection` relPath set and keyed by collection + directory relPath. The
collection root is a first-class directory key (a reported name with no `/` yields the
root, represented as `""`).

Two directory keys are queued for an ambiguous event, because measurement (task `.1`)
showed the parent alone is insufficient:

- the reported path's **parent** directory — covers an atomic save that reports only a
  temp sibling (`note.md.tmp` → the real `note.md` is a sibling);
- the reported path **itself** — covers a recursive directory deletion, which Linux
  reports as the bare directory name (`dir1`) with no child events at all. Its indexed
  children are direct children of `dir1`, not of `dir1`'s parent, so a parent-only rule
  never deactivates them.

The reported path is not stat-able in the deletion case, so both keys are queued
unconditionally for an ambiguous event and resolved at flush time; a key that turns out
not to be a directory yields `missing` from the enumeration seam and reconciles against
the indexed side only, which is exactly the desired deletion behavior.

At flush time, for each dirty directory:

1. enumerate the **direct** eligible children on disk (new single-level enumeration
   helper; `FileWalker.walk` only walks recursively from the collection root and has
   no depth bound);
2. obtain the **active** indexed documents whose relative paths are direct children
   of the same directory (new narrow store query — see Decision context);
3. union and deduplicate those relative paths with any exact paths already pending
   for the same collection;
4. hand the single deduplicated batch to the existing `syncPaths`.

This provides both sides required for reconciliation: eligible files now present on
disk including an atomic writer's unreported final path, and active indexed files no
longer present, enabling normal missing-path deactivation.

### Noise control

An ineligible event is not permission to index the ineligible file. Directory
reconciliation re-applies the current collection include/exclude/pattern/reserved-path
rules to every candidate, at both the queue-time and the existing flush-time
re-filter (`watch-service.ts:332-334`).

Repeated events coalesce by collection + directory inside the existing 300 ms
debounce window. Unchanged files continue to short-circuit through ingestion, and a
reconciliation batch must not produce duplicate `document-changed` events or
redundant embedding work for unchanged neighbours.

## Quick commands

```bash
# Targeted regression suite for this spec
bun test test/serve/watch-service.test.ts

# Ingestion + store suites touched by the new seams
bun test test/ingestion/ test/store/

# Full gates
bun run lint:check
bun run typecheck
bun test
git diff --check
```

## Boundaries / non-goals

- A cron, systemd timer, polling loop, or second watcher implementation
- A full collection sync for every event
- Special handling for `.hermes-tmp`, Vim, Emacs, Obsidian, or any named editor
- Frontend changes
- Reworking the embedding scheduler
- Config-file hot reload beyond existing `updateCollections` semantics
- Guaranteeing recursive discovery for an entire newly moved directory tree in this
  bug-fix slice (a directory rename reconciles the old parent and the new parent, not
  the whole moved subtree)
- Solving platform/runtime defects that provide neither a filename nor a trustworthy
  affected directory. A `null` filename (Bun queue overflow) stays out of scope for
  recovery; R9 only requires that it cannot crash the callback and that it is visible
  in diagnostics so the follow-up can be specified separately.
- Changing the existing event semantics of a deletion. `syncPaths` reports a
  deactivated file with status `updated`, which today emits one `document-changed`
  event; the Web UI depends on that refresh signal. R5 constrains only *new*
  reconciliation-induced noise (unchanged neighbours), not this pre-existing mapping.

## Decision context

**Why directory-bounded reconciliation rather than trusting the event.** Every mature
watcher converges on the same answer — chokidar's `atomic`/`awaitWriteFinish`,
Watchman's settle window and cookie files, and VS Code's native-backend rescan all
treat an event as "something in this directory may have changed" and re-read the
directory. Bun#36328 makes trusting `filename` provably wrong for the exact case this
spec reproduces.

**Why a new narrow store query rather than reusing `listDocuments`.** The spec permits
a store seam only if no existing bounded query is adequate. `StorePort.listDocuments`
(`src/store/types.ts:1605`, `src/store/sqlite/adapter.ts:1513-1535`) issues
`SELECT * FROM documents WHERE collection = ?` with no `active` filter and no path
bound. Reconciliation runs on every ambiguous event, so a whole-table fetch per flush
is not adequate for large vaults. Add one narrow, indexed query returning active
document relative paths that are direct children of a directory, exposed through the
existing store port.

**Why no public status-schema change.** R7 asks for enough diagnostics to distinguish
event receipt from successful reconciliation. `CollectionWatchState`
(`watch-service.ts:260-276`) is mirrored verbatim by
`spec/output-schemas/status.schema.json:491-536`, `docs/API.md:508-518`, and
`docs/WEB-UI.md:460-475`. The existing `CollectionWatchCallbacks`
(`onSyncStart`/`onSyncComplete`/`onSyncError`/`onSettled`) plus structured logging
carry collection + directory + outcome without widening the public contract. If
implementation proves a state field is unavoidable, the schema, contract tests, and
both docs pages change in the same commit.

**Why the store query resolves record source paths.** Record-container documents
(JSONL/transcript exports) live in the store under virtual paths
(`isRecordVirtualPath`, `src/ingestion/record-path.ts:14`) while their physical input
path is `documents.record_source_path` (`spec/db/schema.sql:115`, indexed on
`(collection, record_source_path)` at `:147-149`). `syncPaths` stats physical paths.
The active-children query must therefore return the *effective source path*
(`COALESCE(record_source_path, rel_path)`, distinct), or deleting an eligible record
container would leave all of its logical records active — a silent R3 failure.

**Why the store seam needs an indexed parent key.** A direct-child predicate over
`COALESCE(record_source_path, rel_path)` is not servable by the existing indexes: the
active-path index covers `collection` only, so SQLite would scan every active document
in the collection and build a temporary B-tree for `DISTINCT` — recreating exactly the
whole-collection work this design rejects. The collection-root case is worse: `""` as a
parent is not expressible as a prefix range at all. The seam therefore needs an indexed
*parent* representation (a generated or maintained `source_parent_path` plus a partial
index on `(collection, source_parent_path)` where the row is active), turning both root
and nested lookups into equality probes. `EXPLAIN QUERY PLAN` evidence showing the
parent bound is used is part of the task's acceptance, not a nice-to-have.

**Why the enumeration result is a three-state outcome.** "Directory is gone" and
"directory is unreadable" demand opposite watcher behavior. A vanished directory must
still reconcile against the indexed side so its children deactivate; an `EACCES`/`EIO`
failure must never be read as an authoritative empty directory, because that would
deactivate live documents. The seam returns a discriminated `present(paths)` /
`missing` / `error(cause)` result rather than an empty array for both.

**Why diagnostics get their own callback events.** The existing
`CollectionWatchCallbacks` (`watch-service.ts:26-40`) are path-sync-shaped:
`onSyncStart`/`onSyncComplete`/`onSyncError` all carry a `relPaths` array and fire
around `syncPaths`. They cannot express "an ambiguous event arrived", cannot name
which directory was reconciled when several coalesce into one batch, and cannot
report a dropped `null` filename. `CollectionWatchService` has no logger dependency;
its consumers do the logging (`src/cli/commands/daemon.ts:150-170`,
`src/serve/resident-runtime.ts:296`). R7 is therefore satisfied by additive optional
callback events wired into those existing consumers — not by "structured logging" in
the abstract, and still not by widening the public status schema.

**Why generation drift keeps two policies.** The post-sync drift loop
(`watch-service.ts:365-413`) already re-runs a FULL `syncCollection` whenever the
collection generation changed during a flush. That behavior is preserved verbatim for
exact-path batches. It also subsumes any dirty-directory work that was in flight, so
reconciliation adds no second bounded pass on the drift path. The "never a full
collection sync" boundary describes steady-state event handling, not this pre-existing
config-change recovery.

**Why the parent directory and not the whole collection.** Full-collection sync on
every ineligible event turns temp-file churn from a build tool into repeated
whole-vault walks. Direct children of one directory keeps the blast radius
proportional to the event.

## Acceptance Criteria

- **R1:** Exact eligible create and update events continue through the existing
  per-path debounce/sync flow without widening to a directory scan: the reported
  file EXISTS, so the event named the whole change. **Amended after the Bun
  1.3.14 measurement below** — a DELETE cannot make that promise. An eligible
  reported path that no longer exists on disk is one sample of a larger removal,
  so it also reconciles its directory, walking up to the shallowest removed
  ancestor. The widening is conditioned on the DISK, not on the event type, and
  costs one `stat` per pending path; the live-edit hot path is unchanged.
  **Bounded after the second review** — because the widening decision is a `stat`
  taken when the flush drains the queue, and Bun coalesces whatever lands in one
  watcher read batch, a path that is deleted and RECREATED before that `stat`
  cannot be distinguished from an edit. Such a path is synced as an edit and
  nothing widens; siblings removed in the same window stay active until another
  event names their area or `gno update` runs. This window is inherent to
  observing removals through a coalescing event stream and is documented rather
  than claimed away. Once a path (or an ancestor) HAS been classified as
  removed, that classification is carried on the queue and survives a later
  recreation: the enumeration that follows may only widen the disk side of the
  union, never narrow a subtree removal back to direct children.
- **R2:** When a filesystem event reports an ineligible or otherwise ambiguous path
  inside a watched collection, GNO discovers an eligible final file created by an
  atomic save in the same directory without a manual `gno update`. Reconciliation is
  bounded to the smallest affected directory and hard-codes no editor, Hermes, or
  temporary-file naming convention.
- **R3:** A watched eligible file deleted after watcher readiness becomes inactive and
  is no longer retrievable without a full collection update. The implementation rests
  on a deterministic failing reproduction of the real event/path condition, not an
  assumed ingestion defect. The measured condition is a recursive directory delete that
  reports only the directory name (see Measured watcher behavior), not a single-file
  delete. This holds up to and including the collection ROOT: a collection
  directory that is genuinely absent from disk deactivates every document
  indexed under it, at any depth. The ancestor walk still refuses to climb past
  the root — that ceiling is what keeps a deletion from escalating above the
  collection — but the ceiling is not a claim that the root exists, and the two
  are now decided separately. Absence (`ENOENT`/`ENOTDIR`) deactivates; a root
  that merely cannot be statted (`EACCES`/`EIO`, a hung mount) fails closed
  under R9 and deactivates nothing.

  The classification never rests on the NAME. A directory may legitimately
  carry a filename-shaped name — `archive.md/` matches a `*.md` collection
  pattern exactly as a document does — so an eligible reported name is not
  evidence that the thing that vanished was a file. A vanished path whose
  parent survived is therefore treated as a POSSIBLE directory and decided on
  the indexed side (R12), never collapsed to its parent because its name looked
  like a document.
- **R4:** Reconciliation consults the current collection configuration and preserves
  `pattern`/`include`/`exclude` behavior, dotfile/temporary/reserved-path exclusions,
  path normalization and collection-root containment, configured limits and
  content-type behavior supplied through existing sync options, and suppression of
  known application-originated writes. Ineligible files remain unindexed even when
  their event causes directory reconciliation.

  Discovery parity with the walker holds for entries the filesystem refuses to
  TYPE, too. `readdir(..., { withFileTypes: true })` returns `DT_UNKNOWN` for
  every entry on several network and FUSE mounts — a NAS- or sshfs-mounted
  collection is an ordinary GNO setup — and such a `Dirent` answers `false` to
  `isFile()` and `isDirectory()` at once. Reconciliation resolves that entry
  with a NO-FOLLOW `lstat` instead of omitting it, so an eligible file is still
  reported and an untyped subdirectory is still descended in the recursive
  case. This is parity, not a new rule: `Bun.Glob.scan` resolves its own
  `unknown` entry kind with an `lstatat` on both measured Bun versions, so a
  full `gno update` indexes these files and dropping them here made the two
  disagree — an atomic save whose only event named an ineligible temporary name
  lost the replacement file, and content written into an untyped subdirectory
  stayed unindexed until a full update. The no-follow policy is unchanged by
  the fallback: a symlink discovered this way is skipped exactly as a
  `Dirent`-typed symlink is, and a typed `Dirent` costs no stat at all. The
  fallback's own failures split the way the surrounding enumeration already
  splits them: an entry that vanished between the `readdir` and the `lstat`
  contributes nothing, anything else fails closed (R9).

  Preserving `exclude` means preserving it at the level it is defined for. It is
  a FILE-level rule, and the walker applies it to files; a DIRECTORY is pruned
  from reconciliation only by an exclusion that provably covers every STRICT
  DESCENDANT of it. That coverage question is decided on its own, per pattern,
  and is never gated on whether the directory's own path matches — the two
  answers legitimately differ in both directions.

  Coverage is decided SYNTACTICALLY, and only two pattern shapes are accepted:

  - a BARE pattern `B` (no glob metacharacters; a trailing `/` is stripped
    first) that roots the directory — `dir` is `B`, lies under `B`, or, for a
    single-segment `B`, has `B` as a component. Sound because every strict
    descendant `dir/rest` inherits the property verbatim: `B` stays a
    (non-final) component, or `dir/rest` still starts with `B/`, which is
    exactly what the file-level rule tests. `node_modules`, `.git`, `drafts`,
    and the directory-contents spelling `node_modules/` all take this branch;
  - a pattern whose LAST segment is `**` over a bare prefix `P` — `P/**`, or
    `**` alone — where `P` roots the directory in the ANCHORED sense. Sound
    because `**` matches any non-empty run of trailing segments. Anchored only:
    `node_modules/**` says nothing about `a/node_modules/x`.

  Every other glob is treated as NON-covering, including ones that match some
  descendants. Coverage is never inferred from sample paths: matching synthetic
  probe descendants does not prove a pattern matches all of them —
  `foo/**/_[^x]*` matches a `_`-prefixed probe at every depth while leaving
  `foo/_a/x.md` indexable — and the asymmetry decides the default. Failing to
  prune costs one bounded enumeration; wrongly pruning strands documents
  permanently.

  An exclusion matching only the directory's own name (`*.md` against a
  directory literally called `foo.md`) does not prune it, because
  `FileWalker.walk` still indexes `foo.md/child.txt`. Pruning there would be
  stricter than the walk and would lose documents rather than work: a recursive
  delete of `foo.md/` reports the bare directory or one arbitrary child, and a
  pruned directory cannot be queried, so the unreported descendants stay active
  and searchable with nothing on disk behind them. Conversely `node_modules/`
  covers everything under `node_modules` while deliberately not matching the
  bare path `node_modules` (that spelling denotes a file of that name), so it
  prunes. Making the trailing-slash form cover its descendants at the FILE level
  is what makes that pruning sound — previously it matched nothing at all, so
  the exclusion was silently dead. Beyond repairing that dead spelling, what is
  INDEXED is unchanged — final file eligibility stays with `matchesWalkPath` —
  and covering exclusions still prune with no scan, so the bound on
  excluded-tree noise (R11) holds.

  Collection-root containment is enforced at TRAVERSAL time, not once before a
  walk. Every directory the enumeration reads — the argument directory and each
  nested directory it descends into — is proven, immediately before it is read,
  to be a real directory (`lstat`, no-follow) whose resolved path lies inside the
  collection root, and is proven afterwards to still be the same `(dev, ino)`.
  The unresolved ENTRY-PATH component chain is proven the same way: each
  component is verified no-follow before the read, and the whole chain's
  `(dev, ino)` is re-proven after it. A single up-front check is not sufficient:
  a directory replaced by a symlink after the check but before its `readdir` (a
  checkout, a sync client, any tree rewrite racing reconciliation) would be
  followed, and files from outside the collection would be returned under
  collection-relative names and indexed by `syncPaths`. Any DETECTED swap fails
  the whole enumeration closed. This changes nothing about what is ELIGIBLE — a
  symlinked directory is still simply skipped, exactly as `FileWalker.walk` and
  `Dirent.isDirectory()` skip it.

  **This is not a claim of race-freedom, and must not be read as one.** The
  traversal walks PATH STRINGS, one `lstat` at a time, so it is not atomic: for
  `a/b`, `a` can be renamed away and replaced by a symlink after `a` has been
  verified and before `a/b` is examined. The post-read re-proof of the component
  chain catches that replacement while it is still in place, and every directory
  actually read is independently re-proven identical across its own `readdir`,
  so the detectable window is narrow and every detection fails closed. What is
  NOT excluded is a replacement that is undone before the re-check (swap, let
  the read happen, swap back) or one that preserves `(dev, ino)`. Closing those
  requires traversal relative to verified directory handles with no-follow
  semantics — `openat(dirfd, name, O_NOFOLLOW)` plus `fdopendir` — and
  Node/Bun's `fs` API exposes no dirfd-relative operations at all, so it cannot
  be written in this runtime; it would need such an API or a native addon. The
  honest guarantee is therefore: containment is enforced at traversal time and
  any detected change fails closed; a sufficiently precise adversarial
  rename-plus-symlink racing the walk is not fully excluded. This is the same
  documented-boundary discipline applied to the delete/recreate window (R12),
  not an overclaim.

  That no-follow rule covers the ENTRY POINT too. The requested directory and
  every component between it and the collection root are examined unresolved
  (`lstat`, no-follow) BEFORE anything is canonicalized, so an in-root alias
  (`root/alias -> root/real`) is not silently dereferenced into an enumeration
  of its target. The collection root itself is still canonicalized — it is
  legitimately a symlink (`/tmp -> /private/tmp` on macOS).

  A symlink standing at or above the entry point is classified `skipped`
  WITHOUT resolving it, and that is independent of where it points. An in-root
  alias and one escaping the collection are equally unreachable to
  `FileWalker.walk`, so both mean "the whole subtree is out of reach" and both
  must widen the indexed side to the subtree. Resolving first and refusing an
  escaping link as an enumeration `error` was strictly worse than the walk: an
  `error` is fail-closed and infers no deactivation, so a directory replaced by
  a link to a tree outside the collection stranded every document indexed
  beneath it while a full `gno update` removed them all. Containment is
  unweakened — nothing is read through the link either way; the target is not
  even resolved — and "refused to read" is simply no longer allowed to
  masquerade as "cannot determine". `realpath` still runs for a non-symlink
  entry point and still refuses an argument that resolves outside the root,
  which is what catches a component swapped between the no-follow check and the
  read. Genuine unreadability (`EACCES`, `EIO`) keeps the `error` path under R9
  and deactivates nothing.

  **The no-follow policy is enforced in the INGESTION path, not in the watcher.**
  It lives in `checkWalkPathVisibility` (`src/ingestion/walker.ts`), beside the
  filesystem-free eligibility rule `matchesWalkPath`, and it states the walker's
  measured policy once:

  > A path is walkable iff no component of it below the collection root — the
  > leaf included, whatever it points at — is a symlink.

  That is what `FileWalker.walk` actually does, verified rather than assumed:
  it canonicalizes the ROOT and then scans with
  `Bun.Glob.scan({ onlyFiles: true, followSymlinks: false })`, which emits
  neither a symlink to a directory nor a symlink to a regular FILE, and never
  descends through a symlinked directory at any depth. The root itself stays
  exempt, since it is legitimately a symlink.

  Both consumers read that one rule. The enumeration seam
  (`directory-children.ts`) uses it for the entry-path chain, and — this is the
  part that makes the guarantee hold — `syncPaths` uses it in place of the
  FOLLOWING `stat` it used to open with, so a path the walker cannot reach is
  deactivated exactly as a deleted one is.

  Enforcing it anywhere narrower does not work, and the first attempt proved it.
  Enumeration parity alone only empties the DISK half of the reconciliation
  union; the INDEXED half then reached `syncPaths`, which statted each candidate,
  FOLLOWED the alias, found the file alive and kept the document active — so an
  indexed real `dir/` replaced by `dir -> real` stayed active in the watcher and
  inactive after a full update. Converging that with a private store-mutation
  path inside the watcher removed the symptom and lost everything the ordinary
  batch provides: it re-implemented a subset of `syncPaths` that mutated the
  store BEFORE the flush's generation revalidation, put a whole subtree into one
  `markInactive` statement, reported no candidates (so no `lastEventAt`, no
  `lastSyncAt`, no document-change events, no scheduler notification, no
  deactivated count, and no typed-edge projection), and still could not be
  reached at all by an eligible-NAMED alias (`archive.md -> real/`), whose event
  takes the exact-path branch where no enumeration ever runs.

  With the policy at the ingestion seam all of that follows for free. The
  vanished-path resolver asks `walkerVisible` rather than a following `stat`, so
  an alias reads as gone TO THE WALKER and is widened like any other removal —
  the eligible-named case included. A directory whose entry path is aliased is
  still reported as a distinct SKIPPED enumeration outcome, but that outcome now
  means only "widen the indexed side to the SUBTREE" (an alias at or above the
  entry point puts everything beneath it out of reach, not just the top level).
  The deactivation itself goes through the ordinary batch, inheriting its
  generation revalidation, its per-path `markInactive`, its events, its scheduler
  notification, its counts and its projection.

  The capture/API write path is unaffected: every call site (`gno capture` in the
  CLI, the MCP capture tool, and both SDK sites) does `mkdir -p` on the parent and
  then writes a REGULAR file, so no component of a captured path is ever a
  symlink. A file deliberately written UNDER an aliased directory is now refused
  rather than indexed, which is a correction — a full `gno update` never indexed
  it, so the previous behavior produced a document the next update deactivated.

  Suppression is scoped to SYNCING, not to classification. Its purpose is that an
  application-originated write is not fed back into the watcher as a change, so a
  suppressed path that still exists on disk is never re-synced. It must not also
  discard DELETION evidence: a suppressed path that has VANISHED is not an
  application write, and under a recursive delete reported through one arbitrary
  child (Bun 1.3.14) it may be the only report the watcher ever gets. A suppressed
  path is therefore always classified against the disk, and dropped from the sync
  batch only when it is found to still exist (or could not be resolved at all).

  That rule is on the SYNC side, so it binds every route into `syncPaths`, not
  just the route on which a suppressed path was NAMED by an event. A suppressed
  path that arrives as a RESOLVED candidate of a reconciled directory — the
  indexed child of a recursively removed directory, which no event ever names —
  is subject to the same disk classification and the same fail-closed default.
  Filtering it out unconditionally there left it active and searchable until a
  full `gno update`, because the surviving-parent fallback cannot see nested
  descendants.

  Suppression is decided ONCE, at EVENT time, and that decision is carried on
  the queue. Only the survived-vs-vanished half of the rule may consult the
  disk later. Re-evaluating the suppression WINDOW at flush time is a different
  question than the event asked: the flush runs at minimum a debounce window
  later, possibly behind an in-flight sync and always after an awaited
  classification, so a window that expired in between let an application's own
  surviving write through to `syncPaths` — the exact feedback loop suppression
  exists to prevent, and a regression against the receipt-time drop the
  disk-classified route replaced. This binds resolved reconciliation candidates
  too: they are judged against the observation times of the queued work that
  produced them.

  Deciding at event time requires that suppression state can still be ANSWERED
  for that moment afterwards, so what is retained is suppression MEMBERSHIP —
  windows with a START and an END — not a bare expiry. An expiry records no
  beginning, so a window opened AFTER an event compared as later than that
  event and suppressed it retroactively, and kept doing so even once the window
  itself had lapsed; a genuine external change resolved as a reconciliation
  candidate was then dropped in silence. Resolved candidates are the population
  that cannot avoid this, because they are unknown until the directory is
  enumerated and their question is necessarily asked after the event.
  The two ends of a window are measured in DIFFERENT units, because they answer
  different questions. The END is a wall-clock duration (`suppress(path, 5_000)`)
  and stays in milliseconds. The START is CAUSAL: an event and a `suppress()`
  call made in the same millisecond cannot be ordered by a wall clock, so
  `startMs <= atMs` still answered "suppressed" for an event that arrived
  immediately BEFORE the window opened — the retroactive suppression membership
  exists to remove, surviving at millisecond resolution. Every observation and
  every `suppress()` call therefore draws from one monotonic sequence, and the
  window's start is recorded in it. The epoch timestamp an observation also
  carries is diagnostic only (what `lastEventAt` may publish, and how long
  history must be retained); the two readings are held apart rather than
  overloading one number with both jobs.

  Membership is retained until the LATER of the window's own end and the oldest
  queued or in-flight observation that can still consult it — at most one
  debounce window plus the flush it feeds beyond the window's lifetime — after
  which it is dropped, leaving at most one OPEN window per suppressed path,
  which is what the expiry map held. Reclamation is OPPORTUNISTIC — it runs on
  `suppress()` and at the end of every flush, and nowhere else — so the bound
  this requirement claims is exactly that: **at most one retained entry per
  suppressed path**, reclaimed the next time either trigger fires. An ordinary
  window is still open when the 300 ms flush that queued it finishes, so that
  flush's final reclamation correctly retains it and, on an otherwise idle
  service, it stays until the next `suppress()` or flush. That is the bound the
  single-expiry map already had, so nothing regresses; only the shape of what is
  retained changed. This requirement deliberately does NOT promise that an idle
  service converges to an empty history — no background timer is armed to make
  that true, because a timer armed against a window end must re-arm from its own
  callback, must be cancelled when live observations move a floor it cannot move
  itself, and has its delay silently rounded to 1 ms by Bun above `2**31-1`;
  three ways to spin or leak, bought for a memory bound already met. Two hard
  caps bound the pathological case where nothing is reclaimable, and both
  degrade in the fail-closed direction the rest of this requirement takes.

  Coalescing follows the same `a && b` rule on both routes. A named exact path
  observed at least once OUTSIDE its window is an external change; a resolved
  candidate is dropped only when it was suppressed at EVERY observation that
  asked for its reconciliation KEY. One observation outside the window is proof
  that the application's own write cannot account for every event.

  Witnesses are scoped PER KEY, and a directory HINT is a key of its own. A
  queued entry's whole witness set must not stand in for each hint it carries:
  an event naming sibling hint `b` is not evidence about candidates under hint
  `a`, and one such foreign witness is all it takes to defeat the rule — two
  suppressed `a` observations with an unsuppressed `b` observation between them
  left `a`'s set containing an instant at which its candidate was demonstrably
  not suppressed, so GNO's own surviving write was fed back into `syncPaths`.
  Only observations that asked for the same key are unioned, and they are still
  unioned BEFORE any candidate filter runs, so a witness discovered later is
  never missed by a filter that already ran.
- **R5:** Repeated or coalesced filesystem events for the same collection and
  directory result in one bounded reconciliation batch per debounce window. Unchanged
  files produce no duplicate document-change notifications and no redundant embedding
  scheduling. Adds and updates retain existing event/scheduler behavior.

  The debounce DELAYS work; it never prevents it. Each event re-arms the single
  flush timer, but only up to a hard ceiling measured from the window's first
  queued event, so a process emitting unique names faster than the debounce
  (editor temp files, build intermediates, a sync client) cannot starve the
  flush: queued eligible changes are synced within that ceiling rather than
  never. The ceiling also bounds queue growth in TIME — `hints` stays uncapped in
  ENTRIES, which is what keeps a deleted directory's hint from being dropped as
  if it were a temp name, and drains on the ceiling instead of growing for as
  long as the churn lasts. A burst that finishes inside the ceiling still
  coalesces into exactly one batch and one store round trip per seam.

  The ceiling is measured on a MONOTONIC clock, never on wall time. A backward
  wall-clock step (NTP, a manual change, a resume) makes each event of a
  churning window compute a larger remaining delay and re-arm the full debounce
  again, which would make the "hard" ceiling hold only while the clock is
  well-behaved. Wall-clock readings stay where they are reported or compared
  against caller-supplied durations (`lastEventAt`, suppression window ends).
- **R6:** Queued work is evaluated against the current collection path, filters, sync
  options, and generation. A collection update, removal, root change, or service
  disposal cannot flush stale reconciliation work into the wrong configuration.
  Drift detected **before** enumeration re-resolves the dirty directory against the
  current configuration, or drops it when the root changed or the collection is gone.
  Drift detected **during** any awaited flush stage - path **classification**
  (`stat`-ing reported exact paths), enumeration, or while `syncPaths` is in flight -
  falls to the existing full-`syncCollection` recovery loop, which is a superset of the
  bounded work; reconciliation adds no second compensating pass. The revalidation is
  **unconditional at every flush resume point**, not attached to whichever branch owns
  the current await: an exact-path batch with no dirty directories never enters the
  enumeration branch, so a branch-local guard leaves that batch syncing against a
  configuration that has already moved. On drift the whole in-hand batch is dropped -
  bounded candidates and exact paths alike - and a removed collection drops the batch
  and its queues with no recovery attempt at all.
- **R7:** Additive optional callback events on `CollectionWatchCallbacks`, wired into
  the existing consumers that already log watcher activity, make it possible to
  determine that an ambiguous event was received (including a dropped `null`
  filename), which collection and normalized directory were reconciled, whether
  reconciliation completed or failed and at which stage, and that the watcher remains
  armed. Filenames are treated as untrusted input when formatted. Existing callbacks
  keep their current shape and remain optional, so present consumers compile
  unchanged. Any public status-schema change ships with matching contract tests and
  documentation in the same commit.

  Reported watcher STATE follows the same receipt-vs-outcome distinction. The
  existing `lastEventAt` field means "the watcher observed a real change", so it
  advances for an ambiguous event that was accepted for reconciliation and produced
  work - an atomic save reported only under its ineligible temp name is the primary
  case - and does not advance for an event that was dropped (excluded, dot-prefixed,
  ineligible with nothing reconcilable, or an application's own surviving write).
  The published timestamp is the OBSERVATION time, not the flush time, so the
  debounce window is not reported as latency. No status-schema change is implied:
  `lastEventAt` already exists in `CollectionWatchState` and
  `spec/output-schemas/status.schema.json`.

  Each observation is ATTRIBUTED to the specific path or directory it was made
  for, and only work that reaches the final batch may publish its own. One
  timestamp per collection cannot express the accepted-vs-dropped distinction
  at all: with two directories in one debounce window the later event overwrote
  the earlier, and the first directory's real work then published the DROPPED
  event's timestamp — so `lastEventAt` reported an observation the watcher had
  in fact refused.

  What is published is the ELIGIBLE observation — the one that earned the work
  its place in the batch — never simply the latest one seen for that key. A
  queued path merged from an unsuppressed event at `t1` and a suppressed event
  at `t2` reaches the batch on the strength of `t1`; publishing `t2` reports the
  clock reading of an observation the callback deliberately dropped. Unsuppressed
  and suppressed observations are therefore tracked apart, and a suppressed
  observation is promoted only when the work is retained BECAUSE the path
  vanished, which is exactly the case where no unsuppressed observation exists.

  The suppression WITNESS set is capped; the published observation is not. The
  two are carried side by side per reconciliation key, and `lastEventAt` is
  published from the retained maximum rather than re-derived from the capped
  witnesses — past the cap the witness set no longer holds the latest
  observation, so deriving the timestamp from it reported the moment of the last
  RETAINED witness instead of the latest observation actually accepted.

  The same receipt-vs-outcome discipline governs per-directory sync attribution.
  A directory may report a clean reconciliation only when every failure the sync
  reported BELONGS to a batched path. `syncPaths` also reports collection-level
  failures — synthetic relPaths naming no file (`"(typed edge backfill)"`,
  `"(typed edge projection)"`) and projection errors against backlink documents
  outside the batch — which match no reconciliation candidate. Treating those as
  attributable let every contributing directory report success while the sync had
  failed at the collection level; an unowned failure therefore collapses
  attribution and every contributing directory fails closed (see R9).

  The fail-closed OUTCOME and the reported CAUSE are separate obligations. An
  unattributable failure reports the collection-level error itself and states
  that per-directory attribution was impossible; it does not assert that the
  contributed paths failed, because the result says nothing about them and a
  cause naming the wrong file sends whoever reads the daemon log to the wrong
  place. Where a contributed path IS among the reported failures it is still
  named, alongside the unowned failure that collapsed attribution.

  That cause describes the RESULT, which every contributing directory shares, so
  it is summarized ONCE per sync and reused — never rebuilt per directory — and
  the summary is BOUNDED: a total count, a few sampled failures, and a
  truncated-count suffix. Typed-edge projection can report several failures per
  document, so an unbounded per-directory format scaled as `directories x
  errors` for one constant string, amplifying an already-bad downstream failure
  in the process meant to be diagnosing it. It is also skipped entirely when no
  diagnostic observer is installed; the fail-closed OUTCOME is unconditional and
  never depends on anyone listening.
- **R8:** Tests cover exact-path and ambiguous-event paths deterministically without
  fixed sleeps standing in for synchronization. A real temporary-directory smoke test
  captures Bun's event shape and proves the watch-to-index lifecycle where the
  runtime supports it, with deterministic cleanup and a hard timeout.
- **R9:** A reconciliation-path failure degrades safely and visibly. A **vanished**
  dirty directory still reconciles against the indexed side so its children deactivate.
  An **unreadable** directory (`EACCES`/`EIO`) and a store-query failure fail closed —
  no deactivation is inferred from them — and are reported with their cause. A `null`
  filename is dropped without recovery, but is reported. None of these can throw out of
  the watch callback or silently disarm the watcher; all are visible through the R7
  diagnostics. A sync failure that cannot be attributed to any batched path — a
  collection-level backfill or projection failure — is likewise never read as
  per-directory success: every contributing reconciliation reports a sync-stage
  failure, the same conservative rule already applied to a result carrying no
  per-path detail at all. The reported cause names the collection-level error
  (or, with no per-path detail at all, the count of undetailed failures) and
  says that attribution was impossible — never the contributed paths, which the
  result did not report as failed. It is built once per sync result and bounded
  to a sampled few of the reported failures plus a truncated count, and it is
  not built at all when no observer is installed, so a broad failure cannot be
  amplified by the diagnostic describing it.
- **R10:** Reconciliation resolves record-backed documents through their physical
  source path, not their virtual record path. Deleting or atomically replacing an
  eligible record container reconciles every active logical record derived from it.
- **R11:** The active-children lookup is index-served for both the collection root and
  nested directories — no whole-collection scan and no temporary B-tree for `DISTINCT`
  — proven by a query plan captured as evidence. The same holds for the active
  DESCENDANT lookup added for removed subtrees: a bounded range over the parent
  key (`>= 'dir1' AND < 'dir10'`, with an exact containment residual so `dir1`
  can never match `dir10/x.md`), single and batched, index-served at every key
  count.
- **R12:** A recursive directory deletion deactivates **every** indexed document
  beneath the removed directory, at any depth, however the runtime reports it —
  as the bare directory (Bun 1.3.11), as one arbitrary child at any depth (Bun
  1.3.14), or as children plus the directory (macOS). The earlier "direct
  children only" limitation is REMOVED: the watcher resolves the shallowest
  removed ancestor from disk and reconciles its whole subtree against an indexed
  descendant lookup. A directory that still EXISTS stays direct-children-bounded,
  so nothing nested below a surviving directory is pulled in by a temp-file
  event. Deleting the collection ROOT is the same case one level up and is
  covered: the whole collection's active documents deactivate, from the
  whole-collection indexed seam that the bounded descendant lookup cannot
  express for `""`.

  This holds however the removed directory is NAMED, including a name that
  matches the collection pattern. A deleted `archive.md/` holding
  `archive.md/child.md` reports the bare `archive.md`, which is ELIGIBLE and so
  arrives on the exact-path route rather than the ambiguous-event route; its
  documents still deactivate. The directory-vs-file decision is made in the
  watcher's classification step, on the indexed side, using the same batched
  active-descendant lookup the ambiguous route uses: descendants beneath the
  vanished path mean a removed subtree, none means an ordinary vanished file
  that collapses to its surviving parent. The path-resolution module stays
  filesystem-only and holds no store dependency, and the discriminator costs no
  per-path query — a whole debounce window's vanished paths are answered in one
  round trip per seam (R5).

  It holds for an EXCLUDED-looking name too. A removed directory whose own name
  matches a file-level exclusion but whose descendants the walker still indexes
  (`exclude: ["*.md"]`, indexed `foo.md/child.txt`) is reconciled rather than
  pruned, so `child.txt` deactivates. Directory pruning is limited to exclusions
  that provably cover descendants — see R4.

  The bounded recursive read that covers the recreated case reaches untyped
  subdirectories as well: a `DT_UNKNOWN` `Dirent` is resolved no-follow rather
  than skipped, so a recreated subtree on a network or FUSE mount is
  reconciled at depth like any other — see R4.

  It also holds when the directory was replaced by a symlink pointing OUTSIDE
  the collection: that enumeration is `skipped`, not `error`, so the removed
  subtree's indexed side is still consulted and deactivated — see R4.

  It holds in the REPLACEMENT direction too, and that sharpens the guarantee:
  an indexed directory deleted and rewritten as a regular FILE of the same
  eligible name inside one debounce window (`archive.md/` holding
  `archive.md/child.md`, then a document `archive.md`) deactivates the whole
  stranded subtree AND indexes the new file. The disk answers "still here" for
  such a path — it is a file — so classification alone cannot see it; the
  reported leaf's no-follow TYPE is therefore carried on the `present` outcome
  and a visible NON-DIRECTORY leaf becomes a REPLACEMENT CANDIDATE for the same
  indexed-descendant discriminator the hints use. It differs from a hint in
  exactly one way, and that difference is what keeps the live-edit hot path
  narrow: a candidate the store answers "nothing indexed here" for produces no
  work at all — no enumeration, no reconciliation, no directory fallback —
  where a hint falls back to reconciling its directory. Every ordinary file
  event is such a candidate, so a fallback would enumerate the parent directory
  of every live edit. The cost is one batched round trip per window on the
  descendant seam (R5) — candidate count tracks event count, round trips do
  not — and no direct-children query at all, since a surviving file has no
  direct-children question to answer. A store predating the batched descendant
  seam gets no replacement detection, the same degradation it already gets for
  subtree-wide hint detection.

  Three documented limitations remain, none about depth:

  - Linux subdirectories created after the watcher started emit no event at all
    on Bun 1.3.11 (bun#15939) and still require `gno update`; the same probe on
    Bun 1.3.14 DID report them, so this is version-dependent rather than
    universal;
  - on Linux, writes into a pre-existing directory that was RENAMED after the
    watcher started are reported under the stale pre-rename path (measured on
    Bun 1.3.14). The watcher deactivates what is gone from the old path but
    never learns the new one, so the files at their new location stay unindexed
    until `gno update`;
  - a deleted path that is RECREATED before the flush's `stat` reads as an edit
    (R1), so a removal coalesced with a recreation inside one debounce window is
    not observed. An ancestor recreated AFTER classification but before
    enumeration does not narrow the reconciliation — that intent is carried on
    the queue, and the DISK side of the union is then read recursively for that
    one subtree, so a file written into a recreated NESTED directory is indexed
    rather than falling between the enumerated top level and the stale indexed
    descendant set. That recursion stays rooted at the recreated directory,
    eligibility-filtered, symlink-free, and contained by the collection root; it
    costs disk reads only and no additional store round trips. The collection
    ROOT is deliberately excluded from it, because recursing from `""` is the
    whole-collection walk this design exists not to do — a recreated root
    remains a `gno update` case, while its indexed side still deactivates
    everything.

## Early proof point

Task `fn-114-reliable-watcher-reconciliation-for.1` validates the core premise: that
the real Bun event stream for an atomic temp-write-plus-rename never names the final
eligible file, and that a deterministic injected replay of that sequence fails today.
If the captured sequence *does* report the final path, the root cause is elsewhere
(normalization, suppression, or ingestion) and the directory-reconciliation design in
`.2`/`.3` must be re-evaluated before implementation.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1  | Exact eligible paths stay on the incremental path; vanished paths widen, and the delete-then-recreate window is documented | fn-114-reliable-watcher-reconciliation-for.1, fn-114-reliable-watcher-reconciliation-for.3, post-review corrective commit | — (guarantee bounded to what a flush-time `stat` can observe) |
| R2  | Ambiguous atomic-write events reconcile the bounded directory | fn-114-reliable-watcher-reconciliation-for.1, fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.3 | — |
| R3  | Deleted eligible documents deactivate live, from a proven repro, up to and including a removed collection root, and never classified by name alone | fn-114-reliable-watcher-reconciliation-for.1, fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.3, post-review corrective commit | — |
| R4  | Eligibility, normalization, containment, suppression preserved — suppression scoped to syncing on every route into `syncPaths` (named exact path AND resolved reconciliation candidate), decided ONCE at event time from retained window MEMBERSHIP rather than a bare expiry, with a CAUSAL start (a monotonic sequence shared by events and `suppress()`) and a wall-clock end, so a window opened after an event cannot suppress it retroactively even within the same millisecond; coalesced work drops a candidate only when suppressed at EVERY observation that asked for the same reconciliation KEY, witnesses scoped per key so a sibling hint's event is not evidence about another hint's candidates; history reclaimed opportunistically against the oldest live observation on every `suppress()` and at the end of every flush, bounding it at one retained entry per suppressed path; never applied to classification of a vanished path; containment enforced at traversal time over the unresolved component chain (verified before the read, re-proven after it) with every DETECTED change failing closed — explicitly NOT race-free, since a swap undone before the re-check or one preserving `(dev, ino)` cannot be excluded without dirfd-relative no-follow primitives Node/Bun does not expose; entries whose `Dirent` carries no type (`DT_UNKNOWN`, ordinary on network/FUSE mounts) resolved by a no-follow `lstat` rather than dropped, matching `Bun.Glob.scan`'s own `unknown` arm, with a vanished entry contributing nothing and any other stat failure failing closed, and no stat at all for a typed `Dirent`; the walker's no-follow reachability rule (no symlink component below the root, leaf included, files as well as directories) lives in ONE place beside eligibility (`checkWalkPathVisibility`) and is enforced by `syncPaths` itself, so an unreachable indexed path deactivates through the ordinary batch — with its generation revalidation, per-path `markInactive`, events, scheduler notification, counts and typed-edge projection — rather than through a private store-mutation path | fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.3, post-review corrective commits | — |
| R5  | Coalescing; no duplicate events or redundant embedding | fn-114-reliable-watcher-reconciliation-for.3 | — |
| R6  | Live collection generations respected at EVERY flush resume point (classification and enumeration windows alike) | fn-114-reliable-watcher-reconciliation-for.3, post-review corrective commits | — |
| R7  | Diagnostics distinguish event receipt from reconciliation outcome, including `lastEventAt` attributed per contributing path/directory rather than per collection, published from the ELIGIBLE observation rather than the latest one seen, and carried beside the capped witness set so a stream past the observation cap still publishes the latest ACCEPTED observation; per-directory sync outcomes only where the failure is owned by a batched path, with the unattributable cause summarized once per sync result, bounded, and skipped when no observer is installed | fn-114-reliable-watcher-reconciliation-for.3, fn-114-reliable-watcher-reconciliation-for.4, post-review corrective commits | — |
| R8  | Deterministic regression coverage + real-FS smoke proof | fn-114-reliable-watcher-reconciliation-for.1, fn-114-reliable-watcher-reconciliation-for.4 | — |
| R9  | Reconciliation failures degrade safely and visibly, including a failed descendant query, an unstattable collection root, and an unattributable collection-level sync failure whose reported cause names the collection-level error rather than the contributed paths, built once per result and bounded to a sampled few plus a truncated count, with each named field (path, message) truncated on its own raw value BEFORE composition so the WORK to build the cause is bounded and not just its length, so a broad failure is not amplified by the diagnostic describing it; the fail-closed outcome holds with no observer installed | fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.3, post-review corrective commits | — |
| R10 | Record-backed documents reconcile via their physical source path | fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.3 | — |
| R11 | Active-children AND active-descendant lookups are index-served for root and nested directories | fn-114-reliable-watcher-reconciliation-for.2, fn-114-reliable-watcher-reconciliation-for.4, post-review corrective commit | — |
| R12 | Recursive directory delete deactivates the whole removed subtree, collection root included, directories whose names match the collection pattern, a directory REPLACED by a regular file of that same eligible name (visible non-directory leaf discriminated as a replacement candidate on the shared batched descendant seam, no directory fallback), and a removed subtree RECREATED before enumeration (bounded recursive disk read) | fn-114-reliable-watcher-reconciliation-for.1, fn-114-reliable-watcher-reconciliation-for.3, fn-114-reliable-watcher-reconciliation-for.4, post-review corrective commits | — (depth limitation removed; delete-then-recreate window documented under R1) |

## Test strategy

### RED evidence gate (task `.1`, before any product-code change)

1. Record the real Bun event sequence for: direct create/write; atomic temp-write plus
   rename; eligible file deletion; atomic replacement of an existing eligible file.
2. Add a deterministic watcher test that injects the observed ambiguous sequence
   through the existing `watchFactory` harness
   (`test/serve/watch-service.test.ts:11-46`) and fails because the final eligible
   file is never synced.
3. Add or adapt deletion coverage to reproduce the live stale-active condition. If the
   fake-watcher harness cannot reproduce it, document the event-shape gap in the task
   evidence and add the smallest real-filesystem seam that can.
4. Preserve the RED command and output as task evidence. Do not weaken expectations to
   make the baseline pass.

### Required automated cases

- eligible file added after watcher readiness through an exact event;
- eligible file updated through an exact event;
- atomic create where only a temporary/ineligible event path is reported;
- atomic replacement of an existing eligible file;
- deletion of an indexed eligible file;
- ambiguous event for a file directly in the collection root (empty-string parent);
- ambiguous event in a nested subdirectory;
- excluded dotfile/temp/reserved file remains unindexed after reconciling its directory;
- unrelated excluded-path noise does not cause unbounded collection work;
- repeated/coalesced events perform one reconciliation batch per window;
- unchanged eligible neighbours produce no duplicate document events or embedding work;
- collection filters changed before flush are honored;
- collection removal / root change / disposal drops stale queued reconciliation safely;
- reconciliation errors (unreadable directory, vanished directory, store failure)
  reach existing error/health diagnostics without disarming the watcher;
- a `null` filename does not throw and is reported as an ambiguous-event diagnostic;
- a vanished dirty directory deactivates its indexed children;
- an unreadable dirty directory deactivates nothing and reports its cause;
- deletion and atomic replacement of an eligible record container reconciles every
  active logical record derived from it.

Use explicit watcher-readiness and `onSettled`/callback synchronization rather than
arbitrary sleeps standing in for a settle signal.

### Real-filesystem smoke

One temp-directory smoke test drives a real recursive `fs.watch` through the atomic
temp-write-plus-rename sequence, with `mkdtemp` setup, deterministic cleanup, and a
hard timeout. It runs where the runtime supports it and skips cleanly otherwise; the
Linux proof is the one that closes the reported defect.

## Risks and mitigations

**Reconciliation amplification.** Noisy temporary-file activity repeatedly scans
directories. Mitigation: coalesce by collection + directory, enumerate only direct
children, preserve the existing debounce, and assert batch counts in tests.

**Large directories.** One directory may contain many documents, and `syncPaths` stats
each path sequentially. Mitigation: stay directory-bounded, reuse eligibility filters,
and avoid content reads before `syncPaths`. The measurement is pinned so it can pass or
fail rather than being declared acceptable after the fact — fixture: one directory with
5,000 eligible files, 500 excluded files, and 200 active-indexed-but-missing paths;
method: five warm runs of one ambiguous event, reporting the median and timing
enumeration, the store query, and the unchanged-`syncPaths` pass **separately** so the
limiting stage is identifiable; criterion: enumeration + store query together at or
under 250 ms median. Exceeding it is not a scope expansion trigger — record the number
and document the ceiling as a known limitation.

**Path escape or stale config.** Malformed relative paths or config mutation could
reconcile outside the intended root. Mitigation: normalize and prove root containment
with the existing helpers, resolve work against the current collection generation, and
discard stale queued work.

**Duplicate events and embedding.** The exact path and the ambiguous parent event can
both arrive for one save. Mitigation: deduplicate exact paths against reconciliation
candidates in a single batch and rely on material sync results for notifications and
scheduling.

**Cross-platform differences.** macOS collapses create/rename/delete into `rename`;
Linux splits them; Windows differs again. Mitigation: keep correctness independent of
event type and name conventions, inject event sequences in deterministic tests, and
keep one real Bun smoke proof.

**Overlap with fn-83.** `fn-83-second-brain-page-types-and-synthesis` task `.3` threads
`contentTypes` rules through `SyncOptions` into every sync entrypoint including
`src/serve/watch-service.ts`. Mitigation: this spec passes sync options through
unchanged and does not alter the `syncPaths` call signature; whichever lands second
rebases on the other.

## Implementation boundaries

Primary files to inspect and likely modify:

- `src/serve/watch-service.ts`
- `test/serve/watch-service.test.ts`
- a single-level eligible-children enumeration helper alongside `src/ingestion/walker.ts`

Store seam (justified in Decision context):

- the store port interface exposing active document paths (`src/store/types.ts`)
- `src/store/sqlite/adapter.ts` and its focused tests

Status/diagnostic contract files (`spec/output-schemas/status.schema.json`,
`docs/API.md`, `docs/WEB-UI.md`) are in scope only if R7 forces a public field.

Do not modify web UI code, unrelated ingestion pipelines, model code, or packaging.

## Data and control flow

```text
fs.watch event
  |
  +-- exact eligible path --------------------+
  |                                           |
  +-- ambiguous/ineligible reported path      |
        -> mark parent dir AND reported path dirty |
        -> coalesce by collection+directory   |
        -> enumerate direct eligible disk children
        -> query active indexed direct children
        -> union + dedupe --------------------+
                                              |
                                              v
                                    existing syncPaths behavior
                                              |
                           +------------------+------------------+
                           |                                     |
                    add/update material                     missing path
                           |                                     |
                 event + embed scheduling                 mark inactive
```

## Open questions

- **ANSWERED by task `.1`:** a single-file delete reports the eligible name on both
  platforms; the ambiguous case is a recursive directory delete reporting only the
  directory. R3/R12 are written against the measured behavior.
- **OPEN, needs the production Bun version.** Production evidence item 5 observed only
  the `.hermes-tmp.<id>` path and never `final.md`. The Bun 1.3.11 Linux capture shows the
  opposite for dot-prefixed temps: the dot name is filtered and only the destination is
  reported. Both cannot be true of the same runtime, so the production host is most
  likely on a different Bun. This does not change the fix — reconciliation covers the
  ambiguous case either way — but it does mean we cannot yet claim the exact reported
  Hermes scenario is reproduced. Confirm the production Bun version before asserting
  that in the PR or changelog.
- Symlink handling: the new direct-children enumeration must match whatever
  `FileWalker.walk` does today (`walker.ts:227-318`). Confirm parity during `.2`
  rather than inventing new behavior.
- macOS case-only renames (`Foo.md` → `foo.md`) on a case-insensitive filesystem —
  document the observed behavior in `.1`; do not add case-folding logic in this slice.

## References

- `src/serve/watch-service.ts:72-85` (`changedPaths`), `:127-232` (`updateCollections`),
  `:197-220` (event callback), `:238-258` (`dispose`), `:260-276` (`getState`),
  `:278-297` (`#queueChange`), `:299-435` (`#flushCollection`), `:448-471` (`#afterSync`)
- `src/ingestion/sync.ts:1164-1382` (`syncPaths`), `:1218-1267` (ENOENT → `markInactive`)
- `src/ingestion/walker.ts:152-175` (`matchesInclude`), `:182-219` (`matchesWalkPath`),
  `:125-144` (`safeRelPath`), `:227-318` (`FileWalker.walk`)
- `src/ingestion/types.ts:293+` (`collectionToWalkConfig`), `src/core/path-rules.ts:31-53`
- `src/ingestion/record-path.ts:14` (`isRecordVirtualPath`); `spec/db/schema.sql:115,145-149`
  (`record_source_path` column and its indexes)
- `src/cli/commands/daemon.ts:150-170`, `src/serve/resident-runtime.ts:296` (watcher
  callback consumers that log)
- `src/store/migrations` (migration framework; `runMigrations` used at
  `src/store/sqlite/adapter.ts:476-477`). SQLite 3.51 via `bun:sqlite` — generated
  columns, expression indexes, and partial indexes are all available
- `src/store/types.ts:1346+` (`StorePort`), `:1605` (`listDocuments`);
  `src/store/sqlite/adapter.ts:1513-1535`, `:1670-1673` (`markInactive`)
- `test/serve/watch-service.test.ts:11-46` (harness), `:550-595` (existing deletion case)
- `spec/output-schemas/status.schema.json:491-536`; `docs/API.md:508-518,614-618`;
  `docs/WEB-UI.md:460-475`; `docs/ARCHITECTURE.md:178`; `docs/DAEMON.md`;
  `docs/TROUBLESHOOTING.md:380-394`
- oven-sh/bun#36328 (atomic rename drops destination filename, Linux),
  #33110 (`('change', null)` on queue overflow), #15939 (new subdirectory children
  missed), #33396 (inotify descriptor leak on moved-out directories)
- Node `fs.watch` caveats: https://nodejs.org/api/fs.html#fswatchfilename-options-listener
- inotify(7): https://man7.org/linux/man-pages/man7/inotify.7.html
- Watchman settle/cookies: https://facebook.github.io/watchman/docs/cookies.html
