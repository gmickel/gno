---
satisfies: [R1, R2, R3]
---
# fn-208-status-endpoint-stalls-while-the.1 Keep the resident event loop free under load

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`/api/resident/status` only reads in-memory state; its stalls were main-thread blocking. Profiling the resident under the soak loads (new `GNO_SOAK_CPU_PROF=<dir>` puts `--cpu-prof` on each soak resident; blocks found as runs of consecutive samples, since Bun's profiler records idle time as large sample deltas) named three kinds of synchronous work:

1. Status builds (`/api/status` -> `store.getStatus` -> `getStoredEmbeddingFingerprint`) checked stored embedding dimensions with `MIN/MAX(length(embedding))` over every vector: 3 ms at 5k vectors, 30 ms at 50k, 116 ms at 200k, per call (83 s CPU in one profiled run). Migration 035 adds `idx_vectors_model_bytes ON content_vectors(model, length(embedding))` and the check runs MIN and MAX as separate queries so each is a covering-index seek (0.001 ms at 200k).
2. Every resident read refreshed the config by re-reading and re-parsing the file (12-58 s CPU per run). `refreshConfig` now skips the reload while a stat stamp (inode, size, mtime, ctime) matches the last good load; any edit, chmod or delete changes it, so a broken file is still reported, never served stale.
3. After a burst of changes (laptop wake) graph projection blocked 1.8-2.4 s: one `incomingLinkSources` statement over every changed identity (links x targets, 1.1 s, cannot yield) and a projection loop that yielded only every 25 documents. Incoming links now resolve in chunks of 8 with a new time slicer (`src/core/time-slice.ts`, yields when a slice passes 20 ms) between chunks and between documents (the every-25 yield stays as a floor).

R3: soak I4 limit set from the measured healthy baseline (seed 5 torture config-edit/sse-flood/sleep-wake/embed-faults + seed 1 smoke, Linux): worst p99 65 ms, worst max 65 ms -> `statusP99Ms` 150, `statusMaxMs` 1000 (was provisional 250 / 8000), recorded in scripts/soak/config.ts.

Defect route:
- prior fixes: none
- diagnosis: CPU profiles of three soak classes; inclusive time and block analysis named the three sources above; per-call scan cost measured with a synthetic table; config reload counted via a test
- introduced by: skipped: present since the features landed
- base: 09eaf217 tests fail on main (dimensions plan lacks the index, stamp test 7 loads vs 2, time-slice module missing) | head: d4d447ed passes
- live: soak I4 p99 before -> after: sleep-wake 570 -> 65 ms, config-edit 90-122 -> 52 ms, sse-flood 212 -> 19 ms, embed-faults 4 ms (max 20), smoke churn 465 -> 15 ms

R1 named (above). R2 all five scenarios pass I4 within the new limit. R3 limit set and recorded.

Unrelated soak findings in these runs: I8 "extra 1" (a deleted note stays indexed) in config-edit and embed-faults is fn-209; I5 12 s daemon stop in smoke is fn-206 (fixed on main after this branch forked).

Full gate: lint 0 warnings; bun test 6078 pass, 0 fail.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 09eaf217a7fc2d3051ef111b0a6409f36ae39645, d4d447ed80ccd3f852118758c11daeea8e7a93ca, 59dcc33f74a1adae4ba7ce7262b39134a0784a77
- Tests: bun run lint:check && bun test
- PRs: