---
satisfies: [R1, R2, R3]
---
# fn-204-stdio-gno-mcp-fails-to-start-while-a.1 Fix stdio gno mcp startup under concurrent writes

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`SqliteAdapter.syncCollections` (run by every startup: stdio `gno mcp`, CLI commands, the resident) now runs under an immediate transaction. Its deferred read-then-write transaction failed at once with `database is locked` (SQLITE_BUSY_SNAPSHOT) when another process committed in between, so `gno mcp` beside a writing resident exited at startup. CHANGELOG Unreleased Fixed entry added.

Defect route:
- prior fixes: none (git log on src/store/sqlite/adapter.ts syncCollections; bug memory stdio-gno-mcp-fails-to-start-while-a filed by fn-203; no open PRs on the area)
- diagnosis: GNO_PHASE_TRACE placed every failure after "store: index open" and before "collections synced", ~140-380 ms into startup despite a 60 s busy timeout (rules out busy-timeout exhaustion); eliminated syncContexts and upsertCollections (both write first, so the busy handler applies; upsertCollections test passed on base); confirmed the deferred read-then-write upgrade in syncCollections (immediate transaction: 9/30 -> 0/40 failures)
- introduced by: skipped: no known-good revision
- base: 7b762123 regression test fails with "database is locked" | head: 6d93f9e7 passes 5/5
- live: repro (gno mcp started 30-40x beside a resident under churn) 9/30 failed before, 0/40 after; soak smoke seed 1 MCP actor: 9 short + 16 long-lived calls OK, 0 start failures (was 32/32 failed)

R1 fixed (startup waits out the writer). R2 test/store/sync-collections-concurrency.test.ts (child process holds the write lock and commits during the sync). R3 soak smoke shows no "gno mcp failed to start".

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 7b7621236bab87e5ada7bce50408d7ccdb372459, 6d93f9e7ba755255e7069029447cf5019e32de74
- Tests: bun run lint:check && bun test
- PRs: