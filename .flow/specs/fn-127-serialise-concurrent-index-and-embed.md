# fn-127 Serialise concurrent index and embed writes instead of failing on SQLITE_BUSY

## Goal & Context
<!-- scope: business -->

Two `gno` write commands running at once do not queue. The loser exits non-zero with a bare `Error: database is locked`, having done nothing.

This is not hypothetical. In a vault with 23 collections and two hourly scheduled ingest routines plus interactive agent sessions, overlapping writes are the normal case, not the exception. On 2026-08-31 a `gno index projects` failed four consecutive times across ~7 minutes while an hourly routine held the database with `gno index growth-factors`; the same run logged `75 chunks failed to embed` immediately before surfacing the lock error. The operator's own notes record the same collision earlier ("`gno index` collided twice with the resident `gno mcp --enable-write` server").

Downstream, users have already routed around it: this vault ships a `gno-index-safe` wrapper holding an atomic `mkdir` lock so its two scheduled routines serialise. That wrapper exists because gno does not do this itself, and it only works when every caller remembers to use it -- the two skills that were retrofitted use it, the two that were not are exactly the two that collided.

The important framing: **gno already solved this problem once.** `src/core/file-lock.ts` provides cross-process advisory locking (`lockf`/`flock` with a `BEGIN IMMEDIATE` SQLite fallback), and the MCP write surface takes it on `.mcp-write.lock` next to the index database -- the capture, remove-collection, clear-collection-embeddings, trace, and workspace-write tools directly, the index/sync/embed tools via `acquireWriteLock` handed into `JobManager.startTypedJobWithLock`, and the resident runtime's `JobManager` on the same path (`src/serve/resident-runtime.ts:309`). (add-collection guards the *config* file through `applyConfigChange`'s separate config lock, not the database lease.) The CLI write path takes none of this. So the fix is not new machinery; it is applying the existing guard to the commands that skipped it, and making contention legible when it happens.

Non-goal reminder: reads are fine. WAL is on, and readers were never blocked -- `gno search` and `gno query` returned correct results throughout the failing window. Nothing was invisible; the collection's embeddings were simply one pass behind. This spec is about writers only.

## Architecture & Data Models
<!-- scope: technical -->

Three defects compose into the observed failure:

1. **The CLI write path takes no advisory lock.** `withSqliteWriteLock` / `acquireWriteLock` exist and are used by MCP write tools. The `index` and `embed` commands acquire nothing, so two CLI writers race straight to the storage layer.
2. **`busy_timeout` is set to 5000ms** in the SQLite adapter's open path, against write transactions that in practice run for tens of seconds to minutes (an embedding pass over a 1000-document collection). A 5-second timeout against a multi-minute holder is not a queue; it is fail-fast wearing a queue's clothing. Note `file-lock.ts` already defines `MAX_BUSY_TIMEOUT_MS = 60_000`, so the codebase already carries a more realistic ceiling in one module and a 5s floor in another.
3. **No busy-class retry on the write path.** `src/embed/retry.ts` retries *embedding-provider* failures. A `SQLITE_BUSY` / `SQLITE_LOCKED` during chunk persistence is not classified as retryable there, which is the most likely explanation for chunks reported as "failed to embed" in the same run that hit the lock. The classifier already exists -- `isSqliteLockContention` in `file-lock.ts` tests exactly these two codes -- it is simply not consulted by the persistence path.

Design shape: a single **write-lease** wrapper around the CLI mutating commands, taken before the storage layer is opened and released in a `finally`. Lease is per-index-database, not per-collection, because the contention is on one shared `index-default.sqlite` across all collections. The lease file IS the existing `.mcp-write.lock` adjacent to the index database -- reusing that exact path is what makes R9's single namespace true, and it keeps mixed-version interop (an old MCP process and a new CLI still contend on the same file). Waiting is the default behavior; failing is opt-in.

One verified caveat bounds what the lease can promise: the resident runtime's watch-service flushes and embed-scheduler passes write through the store with **no** advisory lease (`src/serve/watch-service*.ts`, `src/serve/embed-scheduler.ts` contain no file-lock usage; only MCP-triggered jobs go through the locking `JobManager`). A CLI writer holding the lease can therefore still hit `SQLITE_BUSY` from a concurrent resident flush. Those writes are short per-transaction (per-batch upserts, not one multi-minute transaction), so the raised `busy_timeout` (R5) plus contention-classified retry (R6) absorb them at the SQLite level. Routing the resident's own write bursts under the lease is explicitly deferred (see Boundaries).

Deliberately NOT in this design: a lock service, a job queue, a per-collection database split, or a daemon requirement. The guard that already exists, applied where it is missing, plus honest reporting.

## API Contracts
<!-- scope: technical -->

**Command-level behavior for every mutating CLI command** (`index`, `embed`, and any command that opens the index for write):

- Default: acquire the write lease, **waiting** up to a bounded ceiling. While waiting, emit one progress line to stderr naming the holder and the elapsed wait, at most once per interval -- not a spinner, not per-poll spam.
- On acquisition: proceed exactly as today.
- On ceiling exceeded: exit non-zero with a message that states (a) that this is contention, not corruption, (b) what held the lock, (c) that a retry is expected to succeed, and (d) the flag to change the wait.

Flags on mutating commands:

- `--lock-wait <duration>` -- how long to wait for the lease. Accepts a duration; default is a bounded wait, not zero and not infinite.
- `--no-wait` -- do not wait; fail immediately on contention with the dedicated exit code. This preserves today's behavior for callers that want it (CI, scripted probes).

Exit codes: contention-after-wait gets its **own** non-zero exit code, distinct from generic failure, so wrappers and scheduled routines can distinguish "busy, retry later" from "broken". The chosen code is stated in the implementation and asserted in tests.

Error text contract -- the current output is the defect, so the replacement is part of the contract. Today:

```
Error: database is locked
```

Required shape (fields shown are the contract):

```
gno: index is busy -- another write is in progress
  held by: gno index growth-factors (pid 93876), running 1m09s
  waited:  120s (--lock-wait)
  This is contention, not corruption. Reads are unaffected. Retry when it finishes,
  or raise the wait with --lock-wait.
```

Holder identification is best-effort: when the holder's identity cannot be determined, the `held by:` line reports what is known rather than being omitted, and never blocks lease acquisition on identification succeeding.

`--json` output on these commands gains a machine-readable contention result carrying at minimum: an outcome discriminator, waited duration, and holder description when known.

**Storage layer:** `busy_timeout` on the index database is raised from 5000ms to a value matched to real write duration and made configurable, with the resolved value inspectable (`gno status` or `gno doctor`). The lease is the primary mechanism; the raised timeout is defense in depth for writers that bypass the lease.

**Persistence retry:** chunk persistence classifies `SQLITE_BUSY` / `SQLITE_LOCKED` via the existing `isSqliteLockContention` predicate and retries with backoff inside the lease, rather than counting the chunk as an embedding failure. A chunk that fails for lock reasons is never reported in the same bucket as a chunk that failed to embed.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Stale lease.** A holder killed with SIGKILL must not wedge the index. The `lockf`/`flock` path releases on process death; the SQLite `BEGIN IMMEDIATE` fallback releases on connection close. Any lease representation added must inherit that property -- no lease file that outlives its owner and requires manual cleanup. This is the single most important constraint: a fix that converts a transient failure into a permanent one is worse than the bug.
- **Self-deadlock.** A command that takes the lease must not re-enter a path that takes it again. Re-entrancy is either supported explicitly or structurally impossible.
- **Resident writers.** `gno mcp --enable-write`, `gno serve`, and `gno daemon` hold the database for long periods. The lease must interoperate with the MCP tools' and `JobManager`'s existing `.mcp-write.lock` usage -- one lease namespace, not two competing ones. If MCP tools and the CLI take *different* locks, this spec has failed. The resident's watch-service and embed-scheduler writes stay outside the lease (deferred; see Architecture caveat and Boundaries) -- for those, R5's raised `busy_timeout` and R6's contention retry are the mechanism, and R11 documents that residual window honestly.
- **Read paths stay untouched.** `search`, `query`, `context build`, `get` must not acquire the lease and must not slow down. WAL already guarantees readers proceed during a write; a regression here would be a serious one, so it is asserted rather than assumed.
- **Long legitimate holds.** A full reindex of a large collection can exceed any reasonable default wait. That is correct behavior -- the caller is told what is happening and given the flag -- but the message must not read as a bug report.
- **Nested/aborted waits.** SIGINT while waiting for the lease exits cleanly without leaving a partial lease or a half-open database.
- **`--no-wait` preserves today's semantics** so existing scripts that treat lock failure as a signal keep working.
- **Backward compatibility.** Callers that currently succeed keep succeeding with unchanged output. The only behavioral change for an uncontended run is none.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Every bulk-mutating CLI command -- `index`, `update`, `embed`, `cleanup`, `vec sync`, `vec rebuild`, `collection clear-embeddings`, `tags add`, `tags rm` -- acquires the shared write lease before opening the index for write and releases it on all exit paths, including thrown errors and signals; `capture` keeps its existing internal hold of the same lock. Single-transaction writers (`collection policy set`, trace/context bookkeeping) are exempt by design: each runs one short SQLite transaction that the raised `busy_timeout` (R5) serialises, and none holds multi-second writes, so a lease wait there would cost interactive latency for no safety gain. R3/R4/R9/R10 contention contracts bind the leased set. Errors: lease acquisition failure surfaces per R3; release failure is logged and never masks the command's own error.
- **R2:** Two concurrent mutating commands against the same index database serialise -- the second waits and then succeeds, rather than failing. Verified by a test that starts a slow writer and a second writer and asserts the second completes successfully. Errors: if the first writer dies mid-hold, the second acquires the lease rather than waiting out the full ceiling.
- **R3:** On contention exceeding `--lock-wait`, the command exits with a dedicated contention exit code, distinct from the generic failure code, and prints the error shape in `## API Contracts` -- naming contention explicitly, describing the holder when determinable, stating that reads are unaffected, and naming the flag. Errors: holder undeterminable → the `held by:` line reports what is known; the message is never omitted.
- **R4:** `--no-wait` reproduces today's fail-immediately behavior with the R3 exit code and message. Errors: no error surface beyond R3.
- **R5:** `busy_timeout` on the index database is configurable, defaults to a value matched to observed write durations rather than 5000ms, and the resolved value is inspectable from a diagnostic command. Errors: invalid configured value → rejected at load with a clear message, falling back to the documented default rather than to zero.
- **R6:** Chunk persistence classifies `SQLITE_BUSY` / `SQLITE_LOCKED` as retryable contention and retries with backoff within the lease; such chunks are never counted or reported as embedding failures. Errors: retries exhausted → reported as contention, distinctly from provider failure, with a non-zero exit.
- **R7:** Read commands acquire no lease and complete normally while a writer holds it. Verified by a test that holds the lease and asserts a read returns correct results within a normal latency envelope. Errors: no error surface beyond existing read errors.
- **R8:** A holder terminated with SIGKILL leaves no lease that blocks a subsequent writer. Verified by a test that kills a holder mid-write and asserts the next writer acquires. Errors: none -- a residual lease is a test failure, not a handled case.
- **R9:** CLI and MCP write paths contend on the same lease namespace -- the existing `.mcp-write.lock` adjacent to the index database -- so an MCP write tool or a resident `JobManager` job holding the lock blocks a CLI writer and vice versa. Verified by a test that holds `.mcp-write.lock` via the existing `acquireWriteLock` and asserts a CLI writer waits. Errors: no error surface beyond R3.
- **R10:** `--json` output on mutating commands carries a machine-readable contention result with an outcome discriminator, waited duration, and holder description when known. Errors: no error surface beyond R3.
- **R11:** Documentation states the concurrency model -- one writer at a time, readers always proceed, wait is the default, `--no-wait` opts out -- and notes that external serialising wrappers are no longer required. The dedicated contention exit code is added to the exit-code table in `spec/cli.md` and to `docs/CLI.md`, and the docs name the residual window: a resident watch/embed flush can still briefly contend at the SQLite level and is absorbed by the raised `busy_timeout` and retry. Errors: none.

## Boundaries
<!-- scope: business -->

Out of scope, one line each:

- **Splitting the shared index database per collection.** Would remove the contention structurally, but changes the cross-collection search story and is a much larger change; the lease is the smaller fix that solves the reported problem.
- **A queue service, job daemon, or scheduler.** The contention is short and bounded; waiting is sufficient.
- **Making writes concurrent.** SQLite permits one writer; this spec makes the second writer wait, not run.
- **Changing the embedding provider retry logic** beyond adding the lock-error classification in R6.
- **Fixing the `Health: DEGRADED` status** observed alongside this incident. It may share a cause with R6, but it is not established as the same defect and gets its own investigation.
- **Deprecating or shipping a replacement for downstream wrappers** such as `gno-index-safe`. R11 documents that they become unnecessary; retiring them is the operator's call.
- **Auto-retry inside scheduled/daemon callers.** Out of scope here; the exit code from R3 is what makes it possible for them.
- **Routing the resident watch-service and embed-scheduler write bursts under the lease.** Verified today they write without it; their transactions are short and per-batch, so R5+R6 absorb the collisions. Taking the lease inside the resident is a larger change to serve/daemon internals and gets its own spec if the residual window proves noisy in practice.

## Decision Context
<!-- scope: both -->

### Motivation
<!-- scope: business -->

The user-visible failure is small -- one command, retry and it works -- but its shape is bad in a way that compounds. It fails silently-ish (non-zero exit, terse message), it fails *after* doing the useful part of the work in the embed case, and it teaches both humans and agents that `gno index` is flaky. An agent reading `Error: database is locked` four times in a row has no way to distinguish contention from a broken index, and reasonably stops trusting the tool. The evidence that this already happened is that a downstream user built and adopted a serialising wrapper rather than reporting a bug.

The cost of not fixing it is paid in confidence, not in data: nothing is lost, embeddings just fall a pass behind while the operator believes they are current. That is the worst property of the bug -- a stale index that reports success on the next run.

### Implementation Tradeoffs
<!-- scope: technical -->

**Why a lease rather than only raising `busy_timeout`.** Raising the timeout alone would paper over it: SQLite's busy handler gives no visibility into who holds the lock, no way to report progress while waiting, and no clean way to distinguish contention from failure at the exit code. The lease makes waiting explicit and observable. The raised timeout stays as defense in depth for any writer that bypasses the lease.

**Why reuse `file-lock.ts` rather than write a new mechanism.** It already handles the hard parts -- `lockf`/`flock` with a `BEGIN IMMEDIATE` fallback, OS-backed release on process death, contention classification via `isSqliteLockContention`. It is already the mechanism the MCP write tools use, and R9 requires one namespace, which is only achievable by reusing it. The location of the gap is the decision here: MCP write tools take the lock and the CLI `index` path does not, which is precisely why two CLI writers race.

**Why wait-by-default rather than fail-by-default.** The overwhelmingly common case is a short overlap with a scheduled routine where waiting produces the correct result with no operator involvement. Fail-by-default optimises for scripts, which `--no-wait` serves explicitly.

**Rejected: per-collection databases.** Structurally eliminates the contention, and under normal circumstances the structural fix would be preferred over machinery that manages the risk. Rejected here only because it changes cross-collection search semantics, which is a product decision well outside a concurrency bug fix. Worth revisiting on its own merits.

**Rejected: documenting the wrapper pattern instead of fixing it.** Pushes a correctness requirement onto every caller, and the evidence is that callers forget -- half the retrofitted skills in the reporting vault took the wrapper and half did not.
