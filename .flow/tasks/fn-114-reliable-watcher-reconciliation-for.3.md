---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R9, R10, R12]
---
# fn-114-reliable-watcher-reconciliation-for.3 Integrate bounded reconciliation into the watcher with lifecycle, dedupe, and diagnostics

## Description
Wire bounded reconciliation into `CollectionWatchService` and turn task `.1`'s RED
tests GREEN. This is the product-code change.

Replace the hard return on an ineligible event path with "mark the reported path's
parent directory dirty". Coalesce dirty directories by collection + directory inside
the existing 300 ms debounce. At flush time, for each dirty directory, union the
eligible direct children on disk (`.2` enumeration) with the active indexed direct
children (`.2` store query), dedupe against any exact pending paths for the same
collection, and hand ONE batch to `defaultSyncService.syncPaths`.

**Size:** M
**Files:**
- `src/serve/watch-service.ts`
- `src/cli/commands/daemon.ts` (wire the new diagnostic events into existing logging)
- `test/serve/watch-service.test.ts`

### Approach

- Keep the exact-eligible fast path byte-for-byte in behavior: eligible reported paths
  still go straight into `#pendingByCollection` with no directory enumeration (R1).
- Add a dirty-directory structure parallel to `#pendingByCollection`, keyed by
  collection name → set of directory relPaths, with `""` for the collection root.
  Reuse the same `#timers` debounce; do not add a second timer mechanism.
- **Queue TWO keys per ambiguous event** (this changed after task `.1`'s measurement —
  the parent alone is provably insufficient):
  - the reported path's PARENT — covers an atomic save reporting only a temp sibling;
  - the reported path ITSELF — covers a recursive directory delete, which Linux reports
    as the bare directory name (`dir1`) with no child events. Its indexed children are
    direct children of `dir1`, so a parent-only rule never deactivates them (R12).
  The reported path cannot be stat-ed in the deletion case, so queue both keys
  unconditionally and let flush-time resolution sort it out: a key that is not a
  directory returns `missing` from the enumeration seam and reconciles against the
  indexed side only — exactly the desired deletion behavior.
- Resolve dirty directories to concrete relPaths inside `#flushCollection`
  (`:299-435`), BEFORE the existing `matchesWalkPath` re-filter at `:332-334`, so
  reconciliation candidates pass through that live-rules recheck like any other path.
- Apply the existing `#suppressedPaths` check (`:214-217`) to each RESOLVED candidate
  path, not to the directory. A suppressed app-originated write inside a reconciled
  directory must stay suppressed.
- Generation drift has TWO policies; do not merge them (R6):
  - **Exact-path batches:** existing behavior verbatim. The post-sync loop at `:365-413`
    already re-runs a full `syncCollection` on a generation change — leave it alone.
  - **Dirty-directory work:** capture the generation at queue time. Drift detected
    BEFORE enumeration re-resolves the directory against the current collection, or
    drops it when the root changed or the collection is gone. Drift detected DURING
    enumeration or while `syncPaths` is in flight falls through to that same existing
    full-`syncCollection` recovery, which is a superset of the bounded work — do NOT
    add a second compensating bounded pass.
  The "never a full collection sync" boundary describes steady-state event handling,
  not this pre-existing config-change recovery; say so in a comment so the next reader
  does not "fix" it.
- Dispose (`:238-258`), `updateCollections` (`:127-232`), a root change, or a collection
  removal drop queued dirty directories for that collection rather than flushing them
  against new config.
- Rely on `changedPaths` (`:72-85`) and `#afterSync` (`:448-471`) unchanged for
  notification/scheduling: only `added`/`updated` results produce events, so unchanged
  neighbours pulled in by reconciliation emit nothing (R5). Verify the
  `result.files`-absent fallback branch (`:81-84`) cannot fire for these batches and
  over-emit; if it can, constrain it.
- Diagnostics need a concrete transport. The existing `CollectionWatchCallbacks`
  (`:26-40`) are path-sync-shaped (every one carries `relPaths` around a `syncPaths`
  call) and cannot express an ambiguous event, name one directory among several
  coalesced into a batch, or report a dropped `null` filename. `CollectionWatchService`
  has no logger — its consumers log (`src/cli/commands/daemon.ts:150-170`,
  `src/serve/resident-runtime.ts:296`).
  Add ADDITIVE OPTIONAL callback events to `CollectionWatchCallbacks` — every existing
  member keeps its shape, so present consumers compile unchanged — covering at least:
  ambiguous event received (collection, normalized directory or `null`, reason:
  ineligible-path | missing-filename), reconciliation started (collection, directory),
  reconciliation completed (collection, directory, candidate count, synced count), and
  reconciliation failed (collection, directory or `null`, stage: enumerate | store |
  sync, cause). Wire them into the daemon logging site so the diagnostics are reachable
  in production, not just in tests. Treat filenames as untrusted input when formatting.
- Do NOT widen `CollectionWatchState` / the public status schema unless it proves
  unavoidable — if it does, `spec/output-schemas/status.schema.json:491-536`, its
  contract test, `docs/API.md:508-518`, and `docs/WEB-UI.md:460-475` all change in the
  same commit.
- Guard `filename` for `null`/empty before any string work (`:199` currently assumes a
  string). A `null` filename is out of scope to RECOVER from; it must not throw and
  must be visible in diagnostics (R9).

### Investigation targets

**Required:**
- `src/serve/watch-service.ts:197-220` (callback + rejection point), `:214-217`
  (suppression), `:278-297` (`#queueChange`, debounce), `:299-435` (`#flushCollection`,
  including the `:332-334` re-filter and `:348-356` `syncPaths` call), `:366-413`
  (generation drift), `:448-471` (`#afterSync`), `:72-85` (`changedPaths`),
  `:238-258` (`dispose`), `:127-232` (`updateCollections`), `:260-276` (`getState`)
- `src/ingestion/sync.ts:1164-1382` (`syncPaths` contract), `:1218-1267` (ENOENT →
  `markInactive`)
- the two seams delivered by task `.2`
- `test/serve/watch-service.test.ts` — the RED cases from `.1`

**Optional:**
- `src/serve/doc-events.ts` — `DocumentEvent` shape
- `spec/output-schemas/status.schema.json:491-536` — only if a state field proves necessary

### Key context

- Task `.1` measured real watcher behavior; read its evidence before designing. Load
  bearing facts: Linux never reports dot-prefixed names; a plain-temp atomic save reports
  only the source; a recursive directory delete reports only the directory; post-watch
  subdirectories are entirely invisible on Linux (no event = no hint, so reconciliation
  cannot help — leave it as a documented limitation, do not build a rescan for it).

- The batch handed to `syncPaths` must be deduplicated: the same save can produce BOTH
  an exact eligible event and an ambiguous parent event. One save must yield one batch
  and at most one `document-changed` per genuinely changed file.
- A deleted file's relPath comes from the store side of the union, not from disk —
  that is what makes live deactivation work through the unchanged `syncPaths` ENOENT
  branch. Do not call `markInactive` directly.
- A dirty directory that has itself been deleted must still reconcile: zero disk
  children, N active indexed children → all deactivate.
- Do not fall back to a full-collection sync for an ineligible event. That is an
  explicit non-goal; assert bounded behavior in tests.
- fn-83 task `.3` will thread `contentTypes` through `SyncOptions` into this same file.
  Pass sync options through unchanged; do not alter the `syncPaths` call signature.

### Acceptance

- [ ] All RED tests from task `.1` pass without weakening their expectations
- [ ] Exact eligible create/update/delete events still take the per-path flow with no
      directory enumeration (asserted, not assumed)
- [ ] An ambiguous/ineligible event causes reconciliation of its parent directory only;
      the atomic-save final file is synced. Collection-root and nested-directory cases
      both covered
- [ ] Atomic replacement of an existing eligible file is picked up
- [ ] A deleted indexed eligible file is deactivated live via the union + `syncPaths`
- [ ] Ineligible files (dotfile/temp/reserved/excluded) remain unindexed even when their
      event triggered the reconciliation
- [ ] Repeated events for the same collection + directory produce exactly ONE
      reconciliation batch per debounce window. Assert RECONCILIATION BATCH counts, never
      delivered event counts — task `.1` measured that Bun collapses everything in one
      watcher read batch into a single event (300 rapid writes delivered 20)
- [ ] A recursive directory delete reporting only `dir1` deactivates `dir1`'s indexed
      direct children (R12). Deeper descendants are NOT expected to deactivate; assert
      that limitation explicitly so it is a known, tested boundary rather than a silent gap
- [ ] Unrelated excluded-path noise causes no unbounded collection work
- [ ] Unchanged neighbours pulled into a batch emit no `document-changed` and schedule
      no embedding work
- [ ] Exact-path and reconciliation candidates for one save dedupe into one batch
- [ ] Collection filters changed before flush are honored; collection removal, root
      change, and `dispose()` drop queued dirty directories safely
- [ ] Suppressed application-originated writes stay suppressed inside a reconciled directory
- [ ] A VANISHED dirty directory deactivates its indexed children; an UNREADABLE one
      deactivates nothing and reports its cause; a store-query failure deactivates
      nothing; a `null` filename is dropped and reported. None throw out of the callback
      or disarm the watcher
- [ ] Deleting and atomically replacing an eligible record container reconciles every
      active logical record derived from it (R10)
- [ ] New additive optional callback events distinguish ambiguous-event-received from
      reconciliation started/completed/failed, carrying collection, normalized
      directory, and failure stage; existing callbacks are unchanged and existing
      consumers compile without edits
- [ ] The daemon logging site consumes the new events, so diagnostics are reachable in
      production and not only in tests
- [ ] Generation drift before enumeration re-resolves or drops the dirty directory;
      drift during enumeration or in-flight sync falls through to the existing
      full-`syncCollection` recovery with no second bounded pass
- [ ] If the public status schema changed, `spec/output-schemas/status.schema.json`, its
      contract test, `docs/API.md`, and `docs/WEB-UI.md` changed in the same commit
- [ ] `bun test test/serve/watch-service.test.ts`, `bun run lint:check`, and
      `bun run typecheck` pass

## Acceptance
- [ ] Task .1 RED tests pass without weakened expectations
- [ ] Exact eligible events keep the per-path flow, no directory scan (asserted)
- [ ] Ambiguous event reconciles the parent directory only; atomic-save final file synced (root + nested)
- [ ] Atomic replacement of an existing eligible file picked up
- [ ] Deleted indexed file deactivated live through the union + syncPaths
- [ ] Ineligible files stay unindexed despite triggering reconciliation
- [ ] One reconciliation batch per debounce window; batch count asserted
- [ ] Excluded-path noise causes no unbounded collection work
- [ ] Unchanged neighbours emit no document-changed and schedule no embedding
- [ ] Exact and reconciliation candidates dedupe into one batch per save
- [ ] Live filter changes honored; removal, root change, and dispose drop stale queued work
- [ ] Suppression still applies to resolved candidate paths
- [ ] Enumeration failure, store failure, and null filename degrade safely and visibly
- [ ] Diagnostics distinguish event receipt from reconciliation outcome, with collection + directory
- [ ] Any public status-schema change ships with contract test and docs in the same commit
- [ ] Watcher suite, lint:check, and typecheck pass


## Done summary
# fn-114 task .3 — fix round 2: hint cap could drop a deletion hint (Codex P1, R3/R12)

Replaced the `MAX_DIRECTORY_HINTS = 8` cap with a batched indexed-side
discriminator. No hint is dropped any more.

Commit: `95809d0d` (base `4bf4442d`), branch
`fn-114-reliable-watcher-reconciliation-for`, workspace
`/Users/daniel/Projects/gno/.claude/worktrees/fn-114-watcher-reconciliation`.

### The new discrimination mechanism

At queue time a dead temp name (`note.md.tmp.7`) and a recursively deleted
directory (`dir1`) are the same thing — a path that no longer exists on disk.
Only the indexed side separates them: a deleted directory has active indexed
children, a dead temp file does not. So a cap on hints can never be safe, and
the cap was the wrong lever; the per-hint COST was the real problem.

`src/serve/watch-service.ts#reconcileDirtyDirectories` now:

1. drops entries queued against a stale root, then collects every directory key
   the flush could need — each affected directory plus each retained hint —
   re-filtered against the CURRENT collection rules;
2. resolves all of them in **one** batched store lookup
   (`#listActiveDirectChildrenBatch`);
3. enumerates the disk only for hints the indexed side proved are real indexed
   directories. A hint with no active indexed children (or an unanswerable
   store) falls back to the affected directory exactly as before;
4. passes the pre-resolved indexed answer into `#reconcileDirectory`, so no
   directory is queried twice in a flush.

Removed: `MAX_DIRECTORY_HINTS`, `DirtyDirectoryEntry.hintsTruncated`, and the
`"hint-budget-exhausted"` member of `AmbiguousWatchEventReason`.

Deliberate non-behavior, documented in the code: a hint with no indexed children
is **not** speculatively enumerated on the chance it is a brand-new
subdirectory. On linux (fn-114 task .1 measurements) a `mkdir` is reported while
the directory is still empty and the writes that follow inside it are never
reported at all, so that enumeration would find nothing on the one platform
where it would be the only chance; on macOS the files inside produce their own
eligible events and take the exact-path fast path.

### Before/after — 25-event coalescing test

| revision | enumerations | store round trips | deletion hint behind 8 temp names |
| --- | ---: | ---: | --- |
| original (no coalescing) | 26 | 25 | reconciled |
| hint cap of 8 (`4bf4442d`) | 9 | 9 | **DROPPED** |
| batched discriminator (this commit) | **1** | **1** | reconciled |

Key count in that single round trip is 26 (25 hints + the affected directory) —
every hint is asked about, none dropped. The test asserts
`harness.started == [{collection:"notes", directory:""}]`, `roundTrips == 1`, and
`calls` length 26.

### New regression test

`test/serve/watch-service.test.ts` → "keeps a deleted-directory hint behind a
burst of unique temp-name hints": emits 8 unique `note.md.tmp.N` hints and THEN
`rename: "dir1"` in one debounce window, with `dir1` holding an active indexed
`dir1/a.md`.

Verified RED against the pre-fix product code (`git stash` of `src/`):

```
Expected to contain: "dir1/a.md"
Received: [ "note.md" ]
(fail) ... keeps a deleted-directory hint behind a burst of unique temp-name hints
```

GREEN after. It also asserts the atomic-save sibling `note.md` rides the SAME
batch, `dir1` itself is never indexed, `roundTrips == 1`, and exactly 2
enumerations.

### Store-seam change

`StorePort.listActiveDirectChildSourcePathsBatch(collection, dirRelPaths)
  → StoreResult<Map<string, string[]>>`

- one entry per requested directory after normalization/de-duplication (so
  "asked and empty" is distinguishable from "never asked" — the watcher reads an
  empty answer as "this hint is a dead temp name");
- source paths de-duplicated per directory in TS, which is where the R10 record
  container collapse now happens for this form;
- one bad key rejects the whole call with `INVALID_INPUT`, matching the
  single-directory seam;
- `src/store/source-path-sql.ts` gains
  `activeDirectChildSourcePathsBatchSql(dirCount)` and
  `ACTIVE_DIRECT_CHILD_BATCH_CHUNK = 898`.

Two deliberate differences from the single-directory statement:

- **`INDEXED BY` pins the plan.** Measured on an 800-row ANALYZE-d database, an
  unhinted `IN (...)` list of 26 keys made SQLite switch to
  `SEARCH documents USING INDEX idx_docs_wiki_relpath_resolve (collection=?)` —
  still a SEARCH, but a collection-wide one reading every active row.
- **No `DISTINCT`.** Across several IN values SQLite cannot satisfy DISTINCT from
  index order and adds `USE TEMP B-TREE FOR DISTINCT` (observed at IN(1)), which
  R11 forbids.

### Raw `EXPLAIN QUERY PLAN` (800 rows, post-`ANALYZE`)

Unhinted, no DISTINCT — the reason `INDEXED BY` is load-bearing:

```
### IN(1)   SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
### IN(3)   SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
### IN(26)  SEARCH documents USING INDEX idx_docs_wiki_relpath_resolve (collection=?)
```

Unhinted, WITH DISTINCT — the reason DISTINCT is dropped:

```
### IN(1)   SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
            USE TEMP B-TREE FOR DISTINCT
```

Shipped statement (`INDEXED BY`, no `DISTINCT`):

```
### INDEXED BY IN(1)   SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
### INDEXED BY IN(3)   SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
### INDEXED BY IN(26)  SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
### INDEXED BY IN(200) SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
```

`test/store/active-direct-children.test.ts` gains 10 tests: batched semantics,
every-key-present, parity with the single seam across all path shapes, R10
container collapse, key de-duplication, empty request, whole-call
`INVALID_INPUT`, closed-store `QUERY_FAILED`, past-chunk-boundary correctness,
and the R11 plan pin at key counts 1/2/9/26/200 plus a scale agreement check.

### Does any bound remain?

**No work-dropping bound anywhere.** `hints` is now unbounded within a window: a
Set of short strings living at most one 300 ms debounce, discriminated in one
round trip.

The single remaining constant, `ACTIVE_DIRECT_CHILD_BATCH_CHUNK = 898`, is a
**statement-shape** bound, not a budget: SQLite's
`SQLITE_LIMIT_VARIABLE_NUMBER` defaults to 999 and one parameter is spent on
`collection`. Past 898 directories the lookup spans more than one statement;
every requested directory is still queried and nothing is dropped. Pinned by the
`ACTIVE_DIRECT_CHILD_BATCH_CHUNK + 5` test.

### Tests touched (guarantees preserved or strengthened, none weakened)

- **coalescing test** — replaced the cap-era budget numbers with the new exact
  measurements (`started == [{notes, ""}]`, `roundTrips == 1`, 26 keys) and
  dropped the now-impossible `hint-budget-exhausted` assertion.
- **EACCES fail-closed test** — the store double positively reports
  `locked/note.md` as active. Was `expect(calls).toEqual([])` (an artifact of
  enumerate-first ordering, which the batched discriminator necessarily
  reverses); now asserts `calls` contains `"locked"` **and** `batches` is empty
  — i.e. the store answer was in hand and the failed enumeration VETOED it.
  Strictly stronger than "we never asked".
- **throwing-diagnostics test** — `started` count 2 → exact
  `[{notes, ""}]`, because the temp hint no longer reaches the disk. Same
  control-flow guarantee, still an exact assertion.

Untouched and green: the three formerly-RED reconciliation cases, the R12
direct-children boundary test (deeper descendants still not deactivated), the
generation-drift-during-enumeration test (which keeps the per-directory fallback
path covered, since its store double exposes only the unbatched seam), dedupe,
suppression, store-failure, root-change, live-rules, unchanged-neighbour, R10
record container, and excluded-noise tests.

### Gates

- `bun test test/serve/watch-service.test.ts test/serve/watch-service.fs-smoke.test.ts test/cli/daemon.test.ts` — 48 pass, 0 fail
- `bun test test/ingestion/ test/store/ test/serve` — 958 pass, 0 fail
- `bun run lint:check` — 0 warnings, 0 errors; formatting clean
- `bunx tsc --noEmit` — clean

Baseline: green (all four commands passed at `4bf4442d` before any edit).
## Evidence
- Commits: f32b0e28d001f534ae79633f8e1dc7eaf8dfedd8, 4bf4442dc8fea79a4efca593807a3eef135d1c99, 95809d0d7de5903f0ce4432374271ad7f9f11978
- Tests: bun test test/serve/watch-service.test.ts test/serve/watch-service.fs-smoke.test.ts test/cli/daemon.test.ts -> 48 pass, 0 fail (conductor-verified on the integrated branch), bun test test/ingestion/ test/store/ test/serve -> 946 pass, 0 fail, bun run lint:check -> 0 warnings, 0 errors; formatting clean, bunx tsc --noEmit -> clean, bun test test/cli NOT run in full: 189 pre-existing macOS failures, filed as fn-116
- PRs: