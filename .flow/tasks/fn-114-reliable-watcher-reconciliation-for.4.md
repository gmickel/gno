---
satisfies: [R7, R8]
---
# fn-114-reliable-watcher-reconciliation-for.4 Integrated verification, large-directory measurement, and documentation reconciliation

## Description
Close the spec: run the full gate set, measure the large-directory cost the risk
section calls out, prove the real-filesystem lifecycle end to end, and reconcile every
piece of documentation the change touches. Docs, CHANGELOG, and any contract wording
land here as ONE task, not one per artifact.

**Size:** M
**Files:**
- `CHANGELOG.md` (`[Unreleased] / ### Fixed`)
- `docs/TROUBLESHOOTING.md` (~`:380-394`, "Daemon is running but nothing updates")
- `docs/WEB-UI.md` (~`:460-475`, "Background Reliability")
- `docs/ARCHITECTURE.md` (~`:178`, the "path-scoped ingestion" sentence)
- `docs/DAEMON.md` (the "reacts only to future file changes" framing)
- `docs/API.md` + `spec/output-schemas/status.schema.json` + `spec/cli.md` — ONLY if
  task `.3` changed the public watcher status shape
- a large-directory measurement recorded in task evidence

### Approach

- Run the canonical gates from `package.json`: `bun run lint:check`,
  `bun run typecheck`, `bun test`, plus `git diff --check`.
- Run the real-filesystem smoke from task `.1` on the platform available here, and on
  Linux where the runtime allows — the Linux run is the proof that closes the reported
  defect. Record command + output as evidence.
- Large-directory measurement — the fixture and the criterion are FIXED by the spec so
  the result can fail, not merely be declared acceptable:
  - fixture: one directory containing 5,000 eligible files, 500 excluded files, and
    200 active-indexed-but-missing paths;
  - method: five warm runs of a single ambiguous event; report the median; time
    enumeration, the store query, and the unchanged-`syncPaths` pass SEPARATELY so the
    limiting stage is identifiable;
  - criterion: enumeration + store query together at or under 250 ms median.
  Exceeding the criterion is not a scope-expansion trigger — record the numbers and
  document the ceiling as a known limitation in `docs/TROUBLESHOOTING.md`. Do not batch
  or paginate in this slice.
- Documentation: describe the new behavior in user terms — atomic saves and deletions
  are now picked up without a manual `gno update`, reconciliation is bounded to the
  changed directory. Follow the CHANGELOG house style (concrete cause, concrete fix);
  the `1.29.6` "Filtered resident watcher events" entry is the tone reference.
- Per CLAUDE.md, if the public status shape changed, `spec/output-schemas/status.schema.json`,
  its contract test under `test/spec/schemas/`, `docs/API.md`, and `spec/cli.md` must
  agree. Verify with `bun test test/spec/`.
- Check the hosted site repo `~/work/gno.sh` for pages describing watcher behavior /
  auto-indexing / the "why didn't it refresh?" failure mode. If a change is needed
  there, it is a separate change in that repo — record what needs updating in the task
  evidence rather than editing it from this worktree.

### Investigation targets

**Required:**
- `CHANGELOG.md` — `[Unreleased]` section and the `1.29.6` entry as a style reference
- `docs/TROUBLESHOOTING.md:380-394`
- `docs/WEB-UI.md:460-475`
- `docs/ARCHITECTURE.md:178`
- the final diff from tasks `.2` and `.3` — documentation must describe what shipped

**Optional:**
- `docs/DAEMON.md`, `spec/cli.md:1727-1760`, `website/_data/features.yml:45-52`

### Key context

- Documentation drift is a stated project rule: behavior change and docs land together.
- `website/docs/` is auto-synced from `docs/` at build time — do not hand-edit it.
- Do not bump the package version here. Versioning happens on merge to main per the
  project's post-merge workflow.

### Acceptance

- [ ] `bun run lint:check`, `bun run typecheck`, `bun test`, and `git diff --check` all
      pass, with commands and output recorded as evidence
- [ ] Real-filesystem smoke run and recorded; the Linux run is included or its
      unavailability is explicitly stated
- [ ] Large-directory measurement run on the specified fixture (5,000 eligible / 500
      excluded / 200 active-missing), five warm runs, median reported, with enumeration,
      store query, and `syncPaths` timed separately
- [ ] The large-directory run re-confirms the store query stays index-served at fixture
      scale (query plan unchanged from task `.2`'s evidence)
- [ ] Enumeration + store query median compared against the 250 ms criterion; a miss is
      recorded with numbers and documented as a known limitation in
      `docs/TROUBLESHOOTING.md`
- [ ] `CHANGELOG.md` `[Unreleased] / ### Fixed` describes the fix in house style
- [ ] `docs/TROUBLESHOOTING.md`, `docs/WEB-UI.md`, `docs/ARCHITECTURE.md`, and
      `docs/DAEMON.md` describe the shipped behavior, with no remaining claim that a
      manual `gno update` is required for atomic saves or deletions
- [ ] If the watcher status shape changed: `spec/output-schemas/status.schema.json`,
      its contract test, `docs/API.md`, and `spec/cli.md` agree and `bun test test/spec/`
      passes. If it did not change, state that explicitly
- [ ] Any `~/work/gno.sh` page needing an update is identified and recorded in evidence
- [ ] No package version bump in this task

## Acceptance
- [ ] lint:check, typecheck, full bun test, and git diff --check pass with recorded output
- [ ] Real-filesystem smoke executed and recorded; Linux run included or explicitly unavailable
- [ ] Large-directory cost measured with stated fixture size; acceptable or documented as a limitation
- [ ] CHANGELOG [Unreleased] Fixed entry in house style
- [ ] TROUBLESHOOTING, WEB-UI, ARCHITECTURE, DAEMON docs match shipped behavior
- [ ] Status contract files agree if the shape changed, or no-change stated explicitly
- [ ] ~/work/gno.sh updates identified and recorded
- [ ] No version bump


## Done summary
# fn-114.4 review-fix handover (Findings 2, 3, 4)

Commit: `7ad6078c` on `fn-114-reliable-watcher-reconciliation-for` (base `160c5a05`).
Task remains `in_progress` — parallel-wave contract, no `flowctl done`, no review dispatch.

### Finding 2 (P1, R8) — real-filesystem watch-to-index lifecycle proof

New file: `/Users/daniel/Projects/gno/.claude/worktrees/fn-114-watcher-reconciliation/test/serve/watch-service.lifecycle.fs.test.ts`

### Structure — nothing in the chain under test is faked

| Layer | What the test uses |
| --- | --- |
| Directory | real `mkdtemp` temp root; the collection root is `<temp>/collection` |
| Watcher | real `CollectionWatchService` with its DEFAULT `watchFactory` (real recursive `node:fs.watch`) — no `watchFactory` override is passed |
| Ingestion | real `defaultSyncService` (initial `syncCollection`, then the watcher's own `syncPaths`) — not patched, not spied |
| Store | real `SqliteAdapter` opened on a real on-disk `index.sqlite`, placed OUTSIDE the watched root so SQLite's own writes can never be read as collection activity |
| Scheduler / event bus | `null` (out of scope; they are consumers, not the chain) |

Harness (`withLifecycleHarness`) creates root → optional `seed` → open store →
`syncCollections` → real initial `syncCollection` → construct + `start()` the
service → run the body. `finally` always does `service.dispose()` → `store.close()`
→ `safeRm(tempDir)`. Per-test hard timeout 60 s; per-wait bound 25 s.

### What it observably asserts

**Test 1 — "an atomic save becomes retrievable without a manual update"**
- genuine atomic save: `Bun.write(note.md.tmp)` then `rename(note.md.tmp → note.md)`
- assertion: `store.searchFts("kryptonite", {collection:"notes"})` returns exactly
  `["note.md"]` — a real BM25 retrieval over content that exists only inside the
  saved file. `searchFts` filters `active = 1`, so this is retrievability, not row
  existence.
- plus `getDocument("notes","note.md").active === true`, and
  `getDocument("notes","note.md.tmp") === null` (the temp source never becomes a document).
- no spy on `syncPaths` anywhere in the file.

**Test 2 — "a recursively deleted directory's children become inactive"**
- seeds `dir1/a.md`, `dir1/b.md`, `keep.md` (all containing `blueberry`) BEFORE the
  watcher, and asserts the initial sync left all three active and all three
  retrievable — that is the precondition the deletion must undo.
- genuine recursive removal: `rm(dir1, {recursive:true, force:true})`.
- assertion: `getDocument("notes","dir1/a.md").active === false` and same for
  `dir1/b.md`, via an observable store query.
- boundedness: `keep.md` stays active and
  `searchFts("blueberry")` collapses to exactly `["keep.md"]`.

### Cross-platform design

Event SHAPE diverges (Linux: atomic save reports only the SOURCE name, recursive
delete reports only the bare directory; macOS: both names / children too). The test
asserts only the OUTCOME, which is identical on both, so the same assertions run
unmodified on macOS and Linux. Event shapes stay captured-not-asserted in
`watch-service.fs-smoke.test.ts`.

### Synchronization — no fixed sleep as a settle signal

1. **Liveness cookie** — before each scenario's action, an eligible
   `gno-cookie-<n>.md` is written into the watched root and the test waits until
   *that document* is active in the store. A positively observed cookie proves the
   whole chain (watcher → 300 ms debounce → reconcile → ingest → store) is live, so
   a later timeout is a real defect rather than a startup race. Not dot-prefixed:
   Bun's Linux recursive watcher never reports dot-prefixed names, so a dotfile
   cookie would hang.
2. **Outcome wait** — `waitFor` re-runs the scenario's own observable query every
   25 ms until it holds or the 25 s bound expires; the timeout message renders the
   store's actual `[relPath, active]` snapshot. The interval is a retry cadence; no
   duration is ever treated as proof that the pipeline finished.

### Runs

**macOS (darwin 25.5.0, Bun 1.3.11)**
```
$ bun test test/serve/watch-service.lifecycle.fs.test.ts
bun test v1.3.11 (af24e281)
 2 pass
 0 fail
 19 expect() calls
Ran 2 tests across 1 file. [2.06s]
```

**Linux (Debian container, Bun 1.3.11, arm64)**
```
$ docker run --rm --tmpfs /tmp:exec -v "$PWD:/repo" \
    -v /tmp/napi-linux/node_modules/@napi-rs/canvas-linux-arm64-gnu:/repo/node_modules/@napi-rs/canvas-linux-arm64-gnu:ro \
    -w /repo -e TMPDIR=/tmp oven/bun:1.3.11 \
    bun test test/serve/watch-service.lifecycle.fs.test.ts
bun test v1.3.11 (af24e281)

test/serve/watch-service.lifecycle.fs.test.ts:
(pass) watch-to-index lifecycle on a real filesystem > an atomic save becomes retrievable without a manual update [1449.00ms]
(pass) watch-to-index lifecycle on a real filesystem > a recursively deleted directory's children become inactive [674.00ms]

 2 pass
 0 fail
 19 expect() calls
Ran 2 tests across 1 file. [2.57s]
```

**Linux, full watcher suite (lifecycle + fs-smoke + unit)**
```
 41 pass
 1 skip
 0 fail
 165 expect() calls
Ran 42 tests across 3 files. [17.73s]
```
The single skip is the pre-existing EACCES "unreadable directory" case — unstageable
as root inside the container, exactly as task .4 already recorded. The lifecycle
tests themselves skip nothing on either platform.

### One environment caveat the conductor should know

The bare Docker command from task .4 (`docker run ... -v "$PWD:/repo" ... bun test`)
mounts the **macOS-built** `node_modules`. `@napi-rs/canvas` then has no Linux native
binding, `pdfjs-dist` cannot polyfill `DOMMatrix`, and **every** document conversion
fails with `INTERNAL: DOMMatrix is not defined` — so the initial sync indexes zero
files. That is a mounted-toolchain artifact, not a product defect: it reproduces on
this branch for the pre-existing `test/ingestion/sync-incremental.test.ts` too
(2 pass / 1 fail in-container with the bare command). The event-shape smoke tests
never noticed because they do no ingestion.

Fix used: install the matching Linux binding once into a scratch dir and overlay just
that one package read-only.
```bash
mkdir -p /tmp/napi-linux && cd /tmp/napi-linux
echo '{"name":"x","version":"1.0.0"}' > package.json
docker run --rm -v /tmp/napi-linux:/out -w /out oven/bun:1.3.11 bun add @napi-rs/canvas@0.1.80
```
(0.1.80 is the version pinned in this repo's lockfile.) Then add
`-v /tmp/napi-linux/node_modules/@napi-rs/canvas-linux-arm64-gnu:/repo/node_modules/@napi-rs/canvas-linux-arm64-gnu:ro`
to the task .4 docker command. Nothing on the host is mutated. On x64 hosts the
package name is `canvas-linux-x64-gnu`.

### Finding 3 (P2) — `docs/DAEMON.md` `--no-sync-on-start`

Replaced "Anything already on disk … stays unindexed until the next `gno update`"
with: the flag **skips the initial collection scan**; untouched pre-existing files
stay unindexed, but a pre-existing file **is** picked up if it changes later, or if a
later ambiguous event reconciles the directory holding it — reconciliation enumerates
every eligible direct child of that directory including files that predate startup.

Verified against shipped code: `CollectionWatchService#reconcileDirectory` calls
`listEligibleDirectChildren(directory, walkConfig)` (`src/serve/watch-service.ts:930`),
which enumerates by eligibility with no mtime or startup filter; the exact-path fast
path (`:328-341`) likewise indexes any eligible reported file regardless of age.

### Finding 4 (P2) — "never a whole-collection walk"

`docs/ARCHITECTURE.md` and `docs/WEB-UI.md` now qualify the claim as **steady-state
behavior under unchanged collection configuration**, and both name the exception: if
the collection configuration changes while a batch is reconciling or while
`syncPaths` is in flight, the watcher recovers with a full `syncCollection`, which
IS a whole-collection walk.

Verified against shipped code: the generation-drift recovery loop in
`#flushCollection` (`src/serve/watch-service.ts:682-727`) compares the current
collection generation against the generation captured at flush start and calls
`defaultSyncService.syncCollection(...)` when they differ — including on the
empty-batch path (`:643-656`), which exists precisely so a rules change that empties
the bounded batch still triggers the full recovery.

### Finding 1 — not addressed here, by instruction

The task file's `TBD` evidence block is the conductor's to write at `flowctl done`
time under the parallel-wave contract. The raw material is in this handover and in
the accompanying evidence JSON; per-stage timings and query plans for the
large-directory fixture belong to the earlier task .4 work already on the branch.

### Gates (all green)

| Gate | Result |
| --- | --- |
| new lifecycle smoke, macOS | 2 pass / 0 fail |
| new lifecycle smoke, Linux (Docker) | 2 pass / 0 fail |
| `bun test test/serve/ test/ingestion/ test/store/ test/spec/` | 1235 pass / 0 fail / 10137 expect |
| `bun test` (full) | 3536 pass / 2 skip / 0 fail / 27086 expect, 434 files (3534 → 3536, the +2 are the new tests) |
| `bun run lint:check` | 0 warnings, 0 errors; oxfmt clean |
| `bunx tsc --noEmit` | clean |
| `git diff --check` | clean |

Baseline: green pre-edit (full suite was already 3534 pass / 0 fail on this branch).
No `GATE_SKIPPED` lines — every gate was run in full.
## Evidence
- Commits: 160c5a056b6fcb08ecaf3f0fb5b058865c449f78, 7ad6078c66815c335504bcda1c9e6bf80cc5643b
- Tests: bun test (FULL canonical gate) -> 3536 pass, 2 skip, 0 fail across 433 files. CONDUCTOR-VERIFIED independently at 3534 pass/0 fail before the +2 lifecycle tests were added., bun test test/serve/ test/ingestion/ test/store/ test/spec/ -> 1235 pass, 0 fail, bun test test/serve/watch-service.lifecycle.fs.test.ts (macOS) -> 2 pass, 0 fail (CONDUCTOR-VERIFIED), bun test test/serve/watch-service.lifecycle.fs.test.ts (LINUX, docker, Bun 1.3.11) -> 2 pass, 0 fail (CONDUCTOR-VERIFIED first-hand, not taken from the worker report), bun run lint:check -> 0 warnings, 0 errors; formatting clean, bunx tsc --noEmit -> clean, git diff --check -> clean
- PRs:
## Recorded evidence (conductor, at completion)

`flowctl done` renders only `commits` / `tests` / `prs` into this file. The records
below were in the evidence JSON but not in the rendered block, which made the task
look unevidenced. Restated here so the task is self-contained.

### Large-directory measurement

Fixture: ONE directory, 5,000 eligible files, 500 excluded files, 200
active-indexed-but-missing paths. Method: five warm runs of a single ambiguous event;
median reported; stages timed separately.

| stage | median |
| --- | ---: |
| enumeration | 7.2 ms |
| store query | 1.5 ms |
| **enumeration + store** | **8.6 ms** |
| unchanged `syncPaths` pass | 16,689.7 ms |

Criterion: enumeration + store query at or under 250 ms median → **PASS**, ~29x margin.

Honest headline: the criterion gated the two stages this work added, and they are
negligible. The limiting stage is `syncPaths` by ~1900x — it re-reads and SHA-256s all
5,000 unchanged files because `decideAction` compares only `sourceHash` while
`sourceMtime` / `sourceSize` sit unused in the store. Pre-existing on every sync path,
but now reachable from one ambiguous filesystem event rather than only an explicit
`gno update`. Documented as a ceiling in `docs/TROUBLESHOOTING.md`; no batching or
pagination added, per the spec's own instruction. Follow-up filed as
`fn-117-short-circuit-unchanged-files-in-sync`.

### Fixture-scale query plan (R11 re-confirmed)

Unchanged at fixture scale, for the single seam and for IN(1) / IN(3) / IN(26):

```
SEARCH documents USING INDEX idx_documents_source_parent_path (collection=? AND <expr>=?)
```

No `SCAN documents`, no `USE TEMP B-TREE FOR DISTINCT`.

### Status-contract decision

**No change needed — verified explicitly, not skipped.**
`spec/output-schemas/status.schema.json`, `docs/API.md`, and `spec/cli.md` are
unmodified on this branch (the only `spec/` change is `spec/db/schema.sql`).
`CollectionWatchState` still carries exactly the seven fields the schema requires.
Task `.3`'s diagnostics were delivered as additive optional **callbacks**, not status
fields, specifically to avoid a public contract change.

### Hosted site audit (`~/work/gno.sh`)

**Could not survey** — the repo is not checked out on this machine (`~/work` does not
exist; no `gno.sh` found under the user's home). Recorded as unavailable rather than
silently skipped.

Surfaces that need a matching update once that repo is available:

- pages mirroring `docs/DAEMON.md` and `docs/TROUBLESHOOTING.md`
- any "why didn't it refresh?" FAQ entry
- continuous / auto-indexing product claims
- anything mirroring `docs/ARCHITECTURE.md`'s now-corrected "path-scoped only" watcher
  description

### Real-filesystem lifecycle proof (R8)

`test/serve/watch-service.lifecycle.fs.test.ts` — real `mkdtemp` root, real
`CollectionWatchService` on its default `watchFactory` (real recursive `fs.watch`), real
`defaultSyncService` ingestion, real on-disk `SqliteAdapter`. No fakes in the chain, no
spy on `syncPaths`. Assertions are observable store queries: an atomic save must become
retrievable via `searchFts` (which filters `active = 1`), and a genuine recursive delete
must flip the direct children to `active === false` while a sibling stays active.

Conductor-verified first-hand, not taken from a worker report:

- macOS — 2 pass / 0 fail
- Linux (Docker, Bun 1.3.11, tmpfs) — 2 pass / 0 fail

Container caveat: the bare docker command mounts macOS-built `node_modules`, so
`@napi-rs/canvas` has no Linux binding, `pdfjs-dist` cannot polyfill `DOMMatrix`, and
every conversion fails — the initial sync then indexes zero files. Environment artifact,
not a product defect (pre-existing `test/ingestion/sync-incremental.test.ts` fails
identically in-container on this branch). Resolved by overlaying one read-only package
built in a scratch container; nothing on the host was mutated.
