---
satisfies: [R1, R2, R3, R8]
---
# fn-114-reliable-watcher-reconciliation-for.1 Capture watcher event shapes and establish RED regression coverage

## Description
Prove the real event shape and land a RED regression **before** any product-code change.
Capture what Bun's recursive `fs.watch` actually reports for the four sequences that
matter, then encode the ambiguous-event and deletion cases as deterministic failing
tests against `CollectionWatchService`.

No product code changes in this task. `src/serve/watch-service.ts` must be untouched
when this task completes; the suite is expected to be RED.

**Size:** M
**Files:**
- `test/serve/watch-service.test.ts` (new failing cases)
- one new real-filesystem probe/smoke file under `test/serve/` (name it for the
  watcher, e.g. `watch-service.fs-smoke.test.ts`) — real `mkdtemp`, deterministic
  cleanup, hard timeout, skips cleanly where the runtime cannot support it
- task evidence only (no source edits)

### Approach

- Reuse the existing fake-watcher harness: `watchFactory` captures the callback, then
  the test invokes `watcherCallback(eventType, filename)` directly
  (`test/serve/watch-service.test.ts:11-46`, examples at `:124-136`, `:168-183`).
  `defaultSyncService.syncPaths` / `syncCollection` are monkey-patched per test and
  restored in `afterEach` (`:39-46`) — that is the assertion seam.
- Reuse `createCollection` / `createSyncResult` helpers (`:11-37`).
- For the real-FS probe, `node:fs/promises.mkdtemp(join(os.tmpdir(), ...))` is the
  correct call — Bun has no native mkdtemp (allowed `node:*` per CLAUDE.md).
- Record captured sequences as `(eventType, filename|null)` tuples in the task
  evidence and as fixture constants the later tasks replay.

### Investigation targets

**Required:**
- `src/serve/watch-service.ts:197-220` — the event callback and the eligibility
  rejection this task must prove is the failure point
- `src/serve/watch-service.ts:278-297` — `#queueChange` and the 300 ms debounce that
  governs settle timing
- `test/serve/watch-service.test.ts:11-46` — harness, mocks, `afterEach` restore
- `test/serve/watch-service.test.ts:550-595` — the existing GREEN deletion case; the
  new deletion repro must explain why that one passes while production fails
- `src/ingestion/walker.ts:182-219` — `matchesWalkPath`; it is filesystem-free, which
  is why a deleted `deleted.md` still passes eligibility

**Optional:**
- `src/ingestion/sync.ts:1218-1267` — ENOENT → `markInactive`, for interpreting results

### Key context

- oven-sh/bun#36328: on Linux, atomic temp-write + rename forwards only the SOURCE
  (temp) name — the destination is never reported. This is the expected capture result
  and the root cause of the production evidence.
- oven-sh/bun#33110: watcher queue overflow surfaces as `('change', null)`. Record
  whether a `null` filename ever appears; the current callback path assumes a string.
- macOS collapses create/rename/delete into `eventType === "rename"`; Linux splits
  them. Capture on whichever platform is available and label the capture with the
  platform and Bun version; the Linux capture is the one that closes the report.
- Do not weaken or delete the existing green deletion test to make room — add
  alongside it.

### Acceptance

- [ ] Captured `(eventType, filename)` sequences recorded in task evidence for: direct
      create/write; atomic temp-write + rename; eligible file deletion; atomic
      replacement of an existing eligible file. Each capture labels platform + Bun version.
- [ ] A deterministic test injects the observed ambiguous atomic-create sequence and
      FAILS because the final eligible file is never passed to `syncPaths`.
- [ ] A deterministic test covers the atomic replacement of an existing eligible file
      and fails for the same reason.
- [ ] Deletion coverage reproduces the live stale-active condition, OR the task
      evidence documents precisely why the fake-watcher harness cannot and names the
      smallest real-filesystem seam that can (with that seam added).
- [ ] The real-filesystem probe uses `mkdtemp`, cleans up deterministically, has a hard
      timeout, and skips cleanly rather than hanging where unsupported.
- [ ] Synchronization uses watcher readiness and `onSettled`/callbacks, not a fixed
      sleep standing in for a settle signal.
- [ ] RED command + output preserved as task evidence. `src/serve/watch-service.ts`
      is unmodified by this task.
- [ ] `bun run lint:check` passes on the new test files.

## Acceptance
- [ ] Real Bun event sequences captured and recorded as evidence for all four scenarios, labelled with platform and Bun version
- [ ] Deterministic RED test for the ambiguous atomic-create sequence
- [ ] Deterministic RED test for atomic replacement of an existing eligible file
- [ ] Deletion repro landed, or the event-shape gap documented with the minimal real-FS seam added
- [ ] Real-filesystem probe with mkdtemp, deterministic cleanup, hard timeout, clean skip
- [ ] No fixed sleeps substituting for settle synchronization
- [ ] RED command and output preserved as evidence; no product code modified


## Done summary
Replaced fn-114 task .1's invented watcher fixtures with tuples captured from a real
recursive `fs.watch` on Bun 1.3.11 under linux 6.10.14 (tmpfs-backed container, genuine
inotify), cross-checked on darwin 25.5.0; rebuilt the real-FS probe's scenario boundary
around observed watcher quiescence plus a retried cookie file (no fixed sleep), split it
into one test per scenario, and narrowed its skip to recognized
recursive-watch-unsupported errors. `src/serve/watch-service.ts` is untouched and the
three reconciliation cases remain RED by design.

### Real Linux capture (Bun 1.3.11, linux 6.10.14-linuxkit, tmpfs)

| scenario | linux | darwin 25.5.0 |
| --- | --- | --- |
| directCreate | `direct.md` | `direct.md` |
| atomicCreatePlainTemp (`note.md.tmp` -> `note.md`) | `note.md.tmp` | `note.md.tmp`, `note.md` |
| atomicCreateHiddenTemp (`.gno-tmp.abc123` -> `hidden-atomic.md`) | `hidden-atomic.md` | `.gno-tmp.abc123`, `hidden-atomic.md` |
| atomicReplaceNested | `nested/note.md.tmp` | `nested/note.md.tmp`, `nested/note.md`, `nested/note.md` |
| fileDeletion | `direct.md` | `direct.md` |
| recursiveDirectoryDeletion (`rm -rf dir1` holding `a.md`,`b.md`) | `dir1` | `dir1/b.md`, `dir1/a.md`, `dir1` |
| newSubdirectoryWrite | (nothing) | `post/d.md` |
| caseOnlyRename | `foo.md` | `Foo.md`, `foo.md` |

All eventTypes were `"rename"` on both platforms. No `null` filename was ever observed.
Verified against a `--tmpfs /tmp:exec` mount (not the macOS bind mount) so these are real
inotify deliveries; an earlier overlayfs run produced identical shapes.

### What the data says, including where it contradicts the spec

1. **bun#36328 is NOT fixed in Bun 1.3.11.** A plain-temp atomic save reports only the
   SOURCE `note.md.tmp`; the destination `note.md` is never reported. The spec's expectation
   holds — but only for non-dot temp names.
2. **The previous fixture was replaying a sequence Linux never produces.** For a
   dot-prefixed temp name the behaviour inverts, and not because the bug is fixed: Bun's
   Linux recursive watcher never reports dot-prefixed names at all (`.hidden1`, `.gno-tmp.*`
   and a `.`-prefixed cookie were all silent), so the source is filtered and only the
   destination survives — which the current code already handles. Fixtures now use
   `note.md.tmp` / `nested/note.md.tmp`.
3. **The old deletion fixture was doubly wrong.** A single-file delete names the deleted
   file on BOTH platforms — which is precisely why the existing green deletion test passes,
   and it was never the production defect. The captured stale-active condition is a
   RECURSIVE DIRECTORY DELETE: Linux reports only `dir1` and never `dir1/a.md` / `dir1/b.md`,
   so both indexed documents stay active forever. The RED test now replays `("rename","dir1")`.
4. **Two further defects captured, recorded not asserted** (out of scope for .1, relevant to .3):
   - Linux does not extend recursion to subdirectories created after the watch began
     (`newSubdirectoryWrite` reported nothing; a follow-up raw probe confirmed writes into a
     post-watch `post/` dir are entirely invisible, and writes into a RENAMED pre-existing dir
     are reported under the stale pre-rename path).
   - Operations landing in one watcher read batch collapse to a single delivered event.
     Measured: a ~5 ms separation is enough to split them; 300 rapid writes delivered 20 events.

### Finding 2 — indexed side is now represented

The deletion RED test uses task .2's seam via a store double exposing
`listActiveDirectChildSourcePaths`, returning `["dir1/a.md","dir1/b.md"]` for `dir1`. It
asserts both stale-active paths reach `syncPaths`, that `dir1` itself and the untouched
sibling `kept.md` do not, and that the indexed side was consulted for `dirRelPath: "dir1"`.
Nothing is scoped down and no fabricated fixture remains.

### Finding 3 — new synchronization mechanism

The fixed 250 ms drain is gone. Each scenario boundary is two observed steps:

1. **Quiescence** — wait for a window in which the watcher reported nothing; the window
   RESTARTS on every observed event, so it tracks real watcher activity rather than assuming
   a settle duration.
2. **Cookie confirmation** — write a uniquely named file into a watched directory and wait
   for the watcher to report *that file*; a dropped cookie is retried until one is observed
   or the bound expires. A positively observed cookie proves the watcher is live and that
   everything it intends to deliver for the preceding operations has been delivered.

A second quiescence follows the cookie so the next action starts a fresh read batch. Both
steps are required: a cookie written immediately after the action lands in the same watcher
read batch and destroys the action's own event (this is why a naive cookie implementation
captured nothing on Linux), and a dot-prefixed cookie is never reported at all. Each scenario
is its own test with its own temp root and watcher; directories a scenario writes into are
seeded BEFORE the watcher starts, because post-watch subdirectories are not watched on Linux.

### Finding 4 — skip discipline

The support probe now skips only on `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ENOSYS`,
`ENOTSUP`, `EOPNOTSUPP`, or a message matching recursive/not-supported. Every other error
(EACCES, EMFILE, ENOSPC, a watcher regression) is rethrown at module load. The capture file
is never written when the run produced no capture.

### RED command and output (intended)

```
$ bun test test/serve/watch-service.test.ts test/serve/watch-service.fs-smoke.test.ts
(fail) ... > syncs the final eligible file when an atomic create reports only the temp name
(fail) ... > syncs an atomically replaced existing eligible file reported only as a nested temp name
(fail) ... > deactivates indexed children when a recursive directory delete reports only the directory
 21 pass
 3 fail
```
All three fail with `NO_SYNC_WITHIN_TIMEOUT`: the ambiguous event is dropped and nothing
reaches `syncPaths`. That is the task .3 deliverable.

### Gates

- `bun run lint:check` — 0 warnings, 0 errors; formatting clean.
- `bunx tsc --noEmit` — clean (rc=0).
- `bun test test/serve/watch-service.test.ts test/serve/watch-service.fs-smoke.test.ts` — 21 pass, 3 fail (the 3 intended RED).
- `bun test test/ingestion/ test/store/ test/serve` — 928 pass, 3 fail (same 3 intended RED; task .2 unregressed).
- `test/serve/watch-service.fs-smoke.test.ts` — 8 pass / 0 fail on darwin 25.5.0 AND on linux 6.10.14 (Bun 1.3.11).
- `src/serve/watch-service.ts` unmodified (`git diff HEAD -- src/serve/watch-service.ts` empty).
- `bun test test/cli` not run: 189 pre-existing macOS failures, out of scope.

Commit: 5b57fb17247e839626785f4ed025c135e3ca9a9e (test files only; the uncommitted
`.flow/tasks/...2.md` done-summary edit and untracked `.flow/specs/fn-116-*` were left
alone as conductor-owned state).
## Evidence
- Commits: fcd8de3ad465d7f4cc37f10f4b55471c74fc906c, 5b57fb17247e839626785f4ed025c135e3ca9a9e
- Tests: bun test test/serve/watch-service.test.ts test/serve/watch-service.fs-smoke.test.ts -> 21 pass, 3 fail (INTENTIONAL RED; all three NO_SYNC_WITHIN_TIMEOUT because src/serve/watch-service.ts:203-212 drops the ambiguous event before #queueChange), bun test test/ingestion/ test/store/ test/serve -> 928 pass, 3 fail (the same 3 intended RED; task .2 unregressed), test/serve/watch-service.fs-smoke.test.ts -> 8 pass / 0 fail on darwin 25.5.0 AND on linux 6.10.14 (Bun 1.3.11), bun run lint:check -> 0 warnings, 0 errors; formatting clean, bunx tsc --noEmit -> clean (rc=0), git diff HEAD -- src/serve/watch-service.ts -> empty (product code untouched, as required), bun test test/cli NOT run: 189 pre-existing macOS failures unrelated to this task, filed as fn-116-macos-testcli-suite-fails-as-a
- PRs: