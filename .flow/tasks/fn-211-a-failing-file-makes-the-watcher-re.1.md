---
satisfies: [R1, R2, R3]
---
# fn-211-a-failing-file-makes-the-watcher-re.1 Record content failures once after a full reconcile

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
A watcher generation reconcile (full collection sync) that completed with any file-level failure requeued the whole generation with fn-202's failure backoff, so the resident re-walked the entire collection every backoff step and then every 5 minutes for as long as a file kept failing. fn-205's startup reconcile made that hit every `gno serve` start on any collection with an unreadable file. Found while verifying fn-209: soak smoke on main failed I1 in the steady phase (`ingest_errors +10`, db +185 KB, ~42 wakeups/s).

Fix (`src/serve/watch-service-flush-generation.ts`): a completed reconcile counts as done. Content failures (permission, corrupt, too large, unsupported, conversion) are recorded once, as `gno update` and the daemon's initial sync do, and retried when the file changes. Store-side failures (`QUERY_FAILED`, `STORE_ERROR`) are transient and could leave a stale document, so only those paths are retried, as exact paths with the existing backoff. Unnamed failures, or a flush that no longer owns the collection, keep the previous generation retry. CHANGELOG entry.

Harness (`scripts/soak/invariants.ts`): convergence also requires no queued or syncing watcher work, so the idle window no longer starts while serve's startup catch-up is still running (stricter, not looser).

Defect route:
- prior fixes: fn-202 (backoff for targeted retries; generation retries inherited it), fn-205 (startup reconcile that exposed it)
- diagnosis: probe on main (5 notes + one chmod 000 note, serve 300 s): ingest_errors 1 -> 6 (10 s) -> 11 (260 s), one full reconcile per backoff step; soak smoke on main reproduced the I1 failure; fn-208's smoke on a pre-fn-205 base passed I1
- introduced by: fn-205 (cccda101) for serve startup; the generation-retry behaviour itself predates it (config edits)
- base: d5c99a37 / main generation code: both new startup-reconcile tests fail (3 full reconciles in 2.7 s) | head: 64b8569a passes
- live: probe on fn-211: ingest_errors flat at 2 for 180 s; soak smoke seed 21: all invariants pass, steady idle cpu 0.25%, 9.1 wakeups/s, db +0 B, ingest_errors +0 (main: FAIL, +10)

R1 completed reconcile counts as done; only store-side failed paths retried. R2 test/serve/watch-service-startup-reconcile.test.ts (content failure: one reconcile, no retries; store failure: one reconcile, path retried with backoff); round6 inventory test keeps its durability intent. R3 smoke passes I1; probe shows no repeated work.

Full gate: lint 0 warnings; bun test 6112 pass, 0 fail.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: d5c99a370f52181b0a4e5715872a4e11ea3ea7ce, 64b8569a01e65fd2b0d0ebfd882c92bfa2097b7d, 6218b572dcad88567b1673c5aaef404022a1d84a
- Tests: bun run lint:check && bun test
- PRs: