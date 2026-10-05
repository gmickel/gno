---
satisfies: [R1, R2, R3, R4]
---
# fn-202-watcher-retries-a-failing-collection.1 Implement watcher retry backoff

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Watcher failure retries now back off per collection: 500 ms after the first failed flush, doubling to a 5 minute cap, reset by a successful flush (R1, R2). Lease-contention retries keep their explicit 5 s delay and do not count (R3). The failure count is cleared on collection removal and dispose (R4). A fresh watcher event drops an armed failure retry and flushes on the normal debounce, and a failed flush that saw new events while it ran re-arms on the debounce (QA finding F1: healthy edits were held 12-14 s, up to 5 min at the cap); internal reschedules without new events still wait. Docs (ARCHITECTURE, TROUBLESHOOTING) and CHANGELOG updated.

Defect route:
- prior fixes: open PRs (2 dependabot, unrelated); git log on src/serve/watch-service-events.ts and embed-scheduler.ts: no watcher retry change; memory bug track: write-lease-gate-missed-embed (same area, different defect); fn-180 bounded the embed scheduler hot loop, not the watcher; gh issues: none matching
- diagnosis: eliminated the embed scheduler's 30 s deferral as the CPU sink (lease held externally, pass deferred every 30 s: 0.2% CPU); eliminated idle resident cost (0.1-0.3% CPU); confirmed the fixed 500 ms watcher requeue of a flush that fails the same way every time (`sourceAvailability: local` collection + one touch: 7.9% CPU, +51 SOURCE_AVAILABILITY_UNSUPPORTED ingest_errors per 30 s, unbounded; unreadable file: +20 per 10 s)
- introduced by: skipped: no known-good revision
- base: 6cc426c7, test made 6 attempts in 2.7 s (fails, expects <= 3) | head: e8a02b2d, test passes (3/3); reset test mutation-checked (fails with the reset removed)
- qa: first pass NEEDS_WORK (F1, introduced P1, reproduced twice: healthy edit indexed 13.7 s / 12.0 s late); fixed in 7511f08c with two failing-first tests (8e84212d); re-run S4: indexed after 1.0 s both runs
- live: isolated resident on head, same repro: 0.2% CPU after touch, +6 errors in the first 30 s then +2 in the next 60 s; embed status settled (no nextRunAt); a change in a healthy collection was embedded and found by /api/search

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 8c577d109b0f75c6337c50c22e8e7e076119089a, e8a02b2d30839135473810454bd87bfe1a83e376, e445b3fc310bf5238dadd6b1824f60781326326e, 6b68fd350d877465c9676e97be862bdfe240d50d, 1c1332ba59b63446aaf0e3cf032c9ad034389aa1, 8e84212d1e17d9936ae059d75ce2b2ae2fd657e3, 7511f08c0d84ccf07d7962042fb3510b2550c37c, fd0d68bcac04423c7bab07020f0c6bb044087d16
- Tests: bun test test/serve/watch-service-retry-backoff.test.ts, bun test test/serve/watch-* test/serve/resident*, bun run lint:check && bun test
- PRs: