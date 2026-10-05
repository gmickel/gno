---
satisfies: [R1, R2, R3, R4]
---
# fn-202-watcher-retries-a-failing-collection.1 Implement watcher retry backoff

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Watcher failure retries now back off per collection: 500 ms after the first failed flush, doubling to a 5 minute cap, reset by a successful flush (R1, R2). Lease-contention retries keep their explicit 5 s delay and do not count (R3). The failure count is cleared on collection removal and dispose (R4). Docs (ARCHITECTURE, TROUBLESHOOTING) and CHANGELOG updated.

Defect route:
- prior fixes: open PRs (2 dependabot, unrelated); git log on src/serve/watch-service-events.ts and embed-scheduler.ts: no watcher retry change; memory bug track: write-lease-gate-missed-embed (same area, different defect); fn-180 bounded the embed scheduler hot loop, not the watcher; gh issues: none matching
- diagnosis: eliminated the embed scheduler's 30 s deferral as the CPU sink (lease held externally, pass deferred every 30 s: 0.2% CPU); eliminated idle resident cost (0.1-0.3% CPU); confirmed the fixed 500 ms watcher requeue of a flush that fails the same way every time (`sourceAvailability: local` collection + one touch: 7.9% CPU, +51 SOURCE_AVAILABILITY_UNSUPPORTED ingest_errors per 30 s, unbounded; unreadable file: +20 per 10 s)
- introduced by: skipped: no known-good revision
- base: 6cc426c7, test made 6 attempts in 2.7 s (fails, expects <= 3) | head: e8a02b2d, test passes (3/3); reset test mutation-checked (fails with the reset removed)
- live: isolated resident on head, same repro: 0.2% CPU after touch, +6 errors in the first 30 s then +2 in the next 60 s; embed status settled (no nextRunAt); a change in a healthy collection was embedded and found by /api/search

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 8c577d109b0f75c6337c50c22e8e7e076119089a, e8a02b2d30839135473810454bd87bfe1a83e376, e445b3fc310bf5238dadd6b1824f60781326326e
- Tests: bun test test/serve/watch-service-retry-backoff.test.ts, bun test test/serve/watch-* test/serve/resident*, bun run lint:check && bun test
- PRs: