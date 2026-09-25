# Investigate detached serve hot loop, raw SQLite lock hold, and ignored SIGTERM

## Conversation Evidence

Operator incident report (paraphrased; host, user, and vault details removed):

- A detached resident server (`gno serve --detach`, pid file in the data dir, port 3000) on macOS, GNO 2.4.0, Bun, ran for about 10 hours at about 99% CPU.
- Its append-only serve log repeatedly showed cycles of: "GNO server running at http://127.0.0.1:3000", "Press Ctrl+C to stop", "[llama] Truncated embedding input from 2087 to 2044 tokens", "Shutting down...".
- During that window every `gno index <collection> --lock-wait 120s` from another process failed with "Error: database is locked". That is a raw SQLite lock error, not the writer-lease BUSY outcome (exit 4).
- `gno serve --stop` sent SIGTERM, which did not stop the process; it escalated to SIGKILL ("Stopped gno serve (pid ..., SIGKILL)").
- Immediately after the kill, indexing worked; a full reindex embedded 1,840 chunks with 0 errors.
- A long-running MCP server holding the same DB open on the same host did not block writes.
- Recurrence on a second macOS host (GNO 2.4.0, Bun): a detached resident (`serve --__detached-child`, port 3000, started by a plain `gno serve --detach`) was at about 100% CPU after roughly 38 hours of uptime. A `gno status` from another process produced no output for more than 5 minutes and had to be killed. `gno serve --stop` again escalated to SIGKILL ("Stopped gno serve (pid ..., SIGKILL)"). The serve log's tail again showed "Shutting down..." followed by further "GNO server running" banners. The index had about 2,200 chunks pending or stale for the current embedding fingerprint; a foreground `gno embed` after the kill cleared all of them with 0 errors in about 4 minutes. The upgraded 2.6.0 resident then idled at 0.1% CPU, but with no backlog left, so this is not evidence that 2.6.0 fixes the loop.
- The same host still had about 20 orphaned `lockf -k -t 0 <tmp>/gno-detach-int-*/data/.resident-owner.lock sh -c "printf READY; exec sleep 31536000"` helper processes, 42 days old, left behind by detach integration test runs.
- Requested shape: small, exploratory, investigation first. State hypotheses grounded in source, define a reproduction attempt, set acceptance for the eventual behavior, keep scope small, and split fixes out after investigation if they are large.

## Goal & Context
<!-- scope: business -->

A resident `gno serve` must be safe to leave running unattended. In the reported incident it burned a CPU core for hours, blocked every CLI index run on the same index with a raw SQLite lock error that the writer-lease wait could not absorb, and ignored a polite stop. [paraphrase] The operator only recovered by force-killing it, and nothing in status output pointed at the cause. [paraphrase]

A related backend-switch vector fork observed the same night is tracked in fn-184-runtime-independent-vector-identity (runtime-independent vector identity).

This spec is investigation first: reproduce the incident, confirm or rule out the hypotheses below, and land the smallest fixes that satisfy the acceptance criteria. [user] If a confirmed root cause needs a larger change, that fix moves into its own spec and this one closes with the findings recorded. [user]

## Architecture & Data Models
<!-- scope: technical -->

Hypotheses to confirm or rule out, in rough order of likelihood. Code locations are listed under Resolved via Codebase.

- **H1 - Log cycles are separate runs, and the real hang is one process.** The detached child appends to one log file across launches, and the llama truncation warning fires at most once per embedding-port instance. Repeated "running / truncated / Shutting down" cycles may therefore be earlier start/stop pairs rather than an in-process restart loop. If true, the last cycle's "Shutting down..." is the stop request being received and the drain never finishing. [inferred]
- **H2 - Unbounded background re-embed of a chunk that keeps failing.** The resident embed scheduler reschedules whenever a pass reports embedding errors or contended writes, with no cross-pass limit. Per-chunk retry limits live only inside one backlog pass, so a chunk that fails on every pass (oversized input, provider error, or a persistence error) is retried every debounce period forever and re-tokenizes large inputs each time. [inferred]
- **H3 - Resident writes hold a raw SQLite write lock outside the shared writer lease.** CLI writers wait on the shared writer lease, but resident background writes (embed persistence, watcher reconciliation/sync) appear not to take that lease and rely on SQLite busy handling. A long or repeated resident write transaction would let a CLI writer acquire the lease, then fail on the SQLite lock itself, which matches the reported raw "database is locked" instead of the lease BUSY outcome. [inferred]
- **H4 - A busy main thread starves the shutdown clock.** Shutdown drain, abort, and exit deadlines are timer-based (about 11s total, just under the 12s stop grace). If the event loop is blocked by synchronous work (tokenization of large inputs, synchronous SQLite, or a native call awaited without yielding), no deadline fires and the process ignores SIGTERM until SIGKILL. The same starvation would also explain 99% CPU. [inferred]
- **H5 - Native model disposal waits on in-flight inference.** Shutdown reaches the native embedding owner after draining; if an in-flight native embed call does not honor abort, disposal can wait past every deadline. [inferred]

Reproduction attempt: [user]

1. A fixture collection containing at least one chunk whose embedding input is well over the model context (so it always truncates), plus one chunk engineered to fail embedding or persistence on every attempt.
2. Start `gno serve --detach` against that fixture's index and let background embedding run for several debounce periods, sampling CPU, the serve log, and the embed scheduler's rerun count.
3. While it runs, repeatedly run `gno index <collection> --lock-wait 120s` from a second process and record whether failures are lease BUSY (exit 4) or raw SQLite "database is locked".
4. Run `gno serve --stop` and record whether SIGTERM alone ends the process and how long it takes.
5. Repeat with a concurrent MCP server holding the DB open, to confirm it is not a factor.

## API Contracts
<!-- scope: technical -->

No new command or endpoint. The existing resident status reported by `gno serve --status` and `gno status` gains a way to show a stuck or repeatedly failing background job (R4); the exact field shape is decided after investigation and shown in the implementing change. [inferred]

## Edge Cases & Constraints
<!-- scope: technical -->

- An oversized chunk that truncates cleanly is not an error; it should embed once and stop. A chunk that genuinely fails must stay durably pending for a later explicit `gno embed`, not be dropped. [inferred]
- Bounded retry must not starve new work: fresh documents arriving after a chunk is parked still get embedded. [inferred]
- Any fix to lock behavior must keep the existing guarantee that a CLI writer waiting on a busy index reports the lease BUSY outcome (exit 4) rather than a raw SQLite error. [inferred]
- Stop must remain bounded even when a native model call is in flight; force-exit after the deadline is acceptable, a hang is not. [inferred]
- Reproduction and tests must not depend on a specific host, user, or vault. [user]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** While a resident server is running and doing background work (embedding, watcher sync), a concurrent `gno index <collection> --lock-wait <N>` either completes or fails with the writer-lease BUSY outcome after waiting; it never fails with a raw SQLite "database is locked" because resident work held a SQLite write lock outside the shared writer lease. Errors: a lease wait that times out reports the existing BUSY outcome and exit 4; no other error surface. [user]
- **R2:** Background embedding of a chunk that truncates or fails cannot loop hot: a truncating chunk embeds once, a failing chunk is retried a bounded number of times with backoff across passes and then parked as pending, and with no pending work the resident process returns to idle CPU. Errors: a parked chunk stays visible as pending/failed for a later `gno embed`; provider or persistence errors are logged once per backoff step, not every pass. [user]
- **R3:** SIGTERM to a resident server (including via `gno serve --stop`) ends the process within a bounded time without SIGKILL escalation, including while background embedding or a native model call is in flight. Errors: if graceful drain exceeds its budget, the process force-exits on its own before the stop grace expires; `--stop` reports SIGKILL only when the process was truly unresponsive. [user]
- **R4:** `gno serve --status` and `gno status` surface a stuck or repeatedly failing background job (for example a re-embed that keeps failing or a background pass running far longer than expected), with enough detail to identify it. Errors: no background job in trouble reports nothing extra; a status read must not block on the stuck job, and `gno status` from another process returns within a bounded time even while a resident is hot-looping (the recurrence showed it silent for more than 5 minutes). [user]
- **R7:** Detach and resident integration tests leave no helper processes behind: after the suite, pass or fail, no `lockf`/`sleep` owner-lock helper started under the tests' temporary roots is still running. Errors: a helper that cannot be reaped fails the test that started it. [user]
- **R5:** The investigation records, for each hypothesis H1 to H5, whether it was confirmed, ruled out, or left unknown, with the reproduction evidence, and any confirmed root cause whose fix is too large for this spec is split into its own spec. No error surface beyond an honest unknown. [user]

## Hang Inventory

Unattended operation needs every long-lived or waiting GNO process to be bounded, observable and stoppable. [user] Known cases, so fixes can be checked against all of them:

- Resident hot loop, raw SQLite lock, ignored SIGTERM: this spec, seen on two hosts (R1 to R4).
- `gno status` blocked indefinitely behind a hot-looping resident: this spec (R4).
- Orphaned owner-lock helpers from detach tests: this spec (R7).
- Backend-switch vector fork and "Inference deadline exceeded" during CPU embedding: fn-184-runtime-independent-vector-identity.
- One writer lease per data directory: `src/core/write-lease.ts` puts `.mcp-write.lock` in the DB directory, so a long `embed` on a separate session-archive index (about 13 minutes for 40,000 chunks) makes `gno index <collection> --lock-wait 300s` on the curated index fail with BUSY (exit 4). This is correct but coarse. Changing lease scope is outside this spec's boundaries and needs its own spec. [paraphrase]

## Boundaries
<!-- scope: business -->

- Not a redesign of the resident runtime, the writer lease, or the embedding pipeline; fixes stay targeted to the confirmed causes. [user]
- Not a change to embedding truncation limits or chunk sizing, or to vector identity and partition forks (moved to fn-184-runtime-independent-vector-identity). [inferred]
- Not a change to how the MCP server holds the DB open; it was observed not to block writes. [paraphrase]

## Decision Context
<!-- scope: both -->

Investigation first because the log evidence is ambiguous: the repeated cycles could be an in-process restart loop or just an append-only log across several runs, and those point at different fixes. [paraphrase] Reproducing against a fixture with an always-truncating and an always-failing chunk tests the lock, loop, and shutdown hypotheses in one run. [inferred] Splitting large fixes out afterwards keeps this spec small. [user]

## Strategy Alignment

- [strategy:Local knowledge lifecycle] A resident server that blocks indexing and loops on one chunk undermines dependable indexing and recovery.
- [strategy:Coherent agent and application surfaces] CLI and resident runtime must share one index without one silently locking out the other.

## Resolved via Codebase

Investigation leads found while capturing (paths current as of GNO 2.4.0 on main):

- Detached launch and stop: `src/cli/detach.ts` (log opened in append mode; stop sends SIGTERM, waits the 12s grace, then SIGKILL).
- Serve banner, signal handlers, and shutdown wait: `src/serve/server.ts` (`process.once` for SIGINT/SIGTERM, prints "Shutting down...", then `runtime.dispose`).
- Shutdown clock: `src/serve/resident-shutdown.ts` and `src/core/shutdown-budget.ts` (drain 5s, abort 5s, exit 1s; stop grace 12s).
- Background embed loop: `src/serve/embed-scheduler.ts` (30s debounce, reschedules on any errors or contended writes with no cross-pass cap).
- Per-pass retry: `src/embed/backlog.ts` and `src/embed/retry.ts` (in-memory retry queue, `MAX_EMBED_CHUNK_ATTEMPTS = 2`, upsert contention backoff).
- Truncation warning: `src/llm/nodeLlamaCpp/embedding.ts` (`truncateForEmbedding`, warns once per port instance).
- Writer lease: `src/core/write-lease.ts` (shared `.mcp-write.lock`); among resident code only capture, findings pass, and some API routes import it, not the embed scheduler or watcher reconciliation (`src/serve/watch-reconciliation*.ts`).
- Resident status: `src/serve/resident-status.ts` (job counts only; no embed scheduler health).
- Related closed specs: fn-127 (serialise concurrent index and embed writes), fn-91 (serve shutdown crash triage), fn-72 (backgrounding flags for serve and daemon).

## Investigation Record (R5)

Reproduced on Linux (Bun 1.4.2, GNO 2.6.0 from this branch's base) in isolated temp roots: temp `GNO_CONFIG_DIR` / `GNO_DATA_DIR` / `GNO_CACHE_DIR` / `HOME`, a cache manifest pointing at the locally cached Qwen3-Embedding-0.6B GGUF, CPU embedding (`GNO_LLAMA_GPU=false`), detached serve on ports 38180-38182. Fixtures: a 3,000-character random-CJK note whose chunk tokenizes to 4,861 tokens (always truncates to 2,044), and an always-failing pass produced by setting `models.inferenceTimeout: 1500` so the page holding that chunk always exceeds its deadline. The incident hosts were macOS; nothing below was observed on macOS.

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| H1 - log cycles are separate runs | Confirmed | `src/cli/detach.ts` opens the log with `openSync(logFile, "a")` and has no respawn path. Three start/stop runs against one fixture produced exactly the incident's shape: three `GNO server running` / `Press Ctrl+C to stop` / `[llama] Truncated embedding input from 4861 to 2044 tokens` / `Shutting down...` blocks, one per pid. The truncation warning fires once per native worker, which is once per run. |
| H2 - unbounded background re-embed | Confirmed, in two forms | (a) A pass that returns failure (`result.ok === false` or errors > 0) rescheduled every 30s with no cap: with the GPU full (CUDA OOM, native worker exit) the log showed `Embed failed: Inference failed ...` every 30s, each pass respawning the native worker. (b) A pass that throws (inference deadline) was dropped as an unobserved rejection: no log line, no `lastRunAt`, no rerun until the next file change, and then the same head page timed out again (about 78 CPU-seconds per pass in the worker, 0 of 46 chunks ever embedded). The silent form matches the incident logs, which show no error lines. A truncating chunk on its own embeds once and stops (CLI embed: 5/5, 0 errors). Fixed here: failures back off 30s/60s/120s/240s, park after 5, log once per step, and thrown passes are counted. The head-page abort that strands later chunks, and the missing startup drain, are split to fn-190-resident-background-embedding-strands-a. |
| H3 - resident writes outside the writer lease | Confirmed (mechanism) | No resident background writer took `.mcp-write.lock` (watcher syncs, embed pages, variant activation). Any resident write transaction longer than the CLI's 60s `busy_timeout` therefore surfaces as a raw `database is locked` after the CLI already holds the lease. On Linux, short resident writes never produced a raw error (12 + 6 + 4 concurrent `gno index --lock-wait` runs against an embedding resident all completed); the long resident transaction behind the incident's raw errors was not reproduced. Fixed here: watcher flushes and each background-embed page (plus the final activation) take the lease with no wait and defer when it is held. Test: a real detached serve does not index a changed file while the test holds the lease, then indexes it after release (fails on the base commit). |
| H4 - busy main thread starves the shutdown clock | Confirmed | The resident's SQLite connection used the configured `busyTimeoutMs` (60s) and bun:sqlite waits synchronously. With another process holding `BEGIN IMMEDIATE`, a watcher sync froze the event loop: `/api/resident/status` timed out for about 55s and `gno serve --stop` reported `SIGKILL` after 12s. The same freeze explains a status request going unanswered. Fixed here: the resident caps its own busy wait at 500ms (1s cap + 11s shutdown clock would equal the 12s grace; an invariant test keeps the sum under it), and resident writes behind a CLI writer no longer wait at all. After the fix: status answered in 6ms, stop took 172ms with SIGTERM. Test: SIGTERM ends a detached serve blocked by an unleased writer without SIGKILL (fails on the base commit with `SIGKILL`). The source of 99-100% CPU on the incident hosts was not reproduced; a SQLite busy wait sleeps rather than spins, so it explains the hang but not the CPU. Unknown. |
| H5 - native disposal waits on in-flight inference | Ruled out (Linux) | Stopping a resident mid-pass while the native worker was evaluating a timed-out batch took 1.3s with SIGTERM; the owned native child was reaped inside the shutdown clock. |

Other findings:

- `gno status` does not block on a held SQLite write lock (155ms with another process holding `BEGIN IMMEDIATE`), so the recurrence's silent `gno status` (over 5 minutes) is not explained by lock contention. Unknown. `gno status` now asks each detached resident for background issues with a 500ms bound and reports a resident that does not answer as `unresponsive`; a real test SIGSTOPs a detached serve and checks both `gno status --json` and `gno serve --status`.
- R7: the orphaned helpers on the second host run `sh -c "printf READY; exec sleep 31536000"`, the hold command `src/core/file-lock.ts` used before #204 (fn-127) replaced it with a stdin-bound `read _` that exits with its owner. No helper survived a full current test run on Linux. The detach integration suite now scans for `lockf`/`flock` helpers under each test's temp root after the test, reaps any it finds, and fails that test.
- The MCP server holding the DB open was not tested separately; its writes take the same lease and it was reported not to block writes.
