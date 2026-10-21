---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-222-queued-coalesced-path-level-reindexing.1 Implement Queued, coalesced, path-level reindexing

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Reindex requests (MCP gno_sync / gno_index, REST POST /api/sync) that arrive while another job runs are queued instead of refused. Pending jobs match on type and collection: a path request joins any of them; a whole-collection request joins a path-only job (setting its options) or a whole job with the same options, so any number of requests cause at most one more pass. Bound of 64 waiting scopes (QUEUE_FULL). Job status reports queued and the merged scope. Path-level reindex on MCP, REST and `gno index <collection> --path`; paths outside the root (including through a symlink, also for missing files) are rejected before queueing; a missing listed file is marked inactive. Queued passes start in a clean context with config captured at submit. Web UI keeps polling queued jobs.

Live stdio probe: 20 concurrent path-level gno_sync calls during a 4,000-file sync were all queued under one job id, which ran once over the 20 files (2 jobs total).

stage: impl-review - ran (codex, 3-reviewer panel then re-review): NEEDS_WORK (6 findings, all fixed) -> SHIP (model: gpt-6.1-sol)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 6a99bf26871d9509225ee870b5d99e243449427e, d6cc0c5c72162ef0c5d1a18ef03bb5b22b44e62d
- Tests: bun test test/core test/mcp test/serve test/cli test/spec test/ingestion test/store
- PRs: