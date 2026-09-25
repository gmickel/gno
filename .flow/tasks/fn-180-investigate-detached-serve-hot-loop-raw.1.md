---
satisfies: [R1, R2, R3, R4, R7, R5]
---
# fn-180-investigate-detached-serve-hot-loop-raw.1 Implement Investigate detached serve hot loop, raw SQLite lock hold, and ignored SIGTERM

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Investigated the detached-serve incident in isolated temp roots (H1-H5 record in the spec) and fixed the confirmed causes: resident watcher syncs and background-embed pages, preparation, and activation now take the shared writer lease without waiting and defer while a CLI writer holds it; the resident caps its own SQLite busy wait at 500ms so SIGTERM stops it inside the 12s grace; failed background embed passes (including previously silent inference-deadline throws) back off, park after 5, and log once per step; `gno status`, `serve --status`, and `daemon --status` report failing, parked, overrunning, or unresponsive residents with a 500ms bound; detach integration tests fail when a lock helper outlives its test. Stranded-backlog follow-up split to fn-190-resident-background-embedding-strands-a. gno.sh troubleshooting docs committed on branch fn-180-serve-incident (worktree ~/work/gno-sh-fn180, not pushed).

Hypotheses: H1 confirmed; H2 confirmed (uncapped 30s retry and silently dropped timeout passes); H3 confirmed as mechanism (resident writes outside the lease), incident's long hold not reproduced; H4 confirmed (60s synchronous busy wait froze the loop, SIGKILL on stop); H5 ruled out on Linux. Unknown: source of 99-100% CPU on macOS, and the >5 min `gno status` hang.

Tests: R1 test/cli/detach.integration.test.ts "resident watcher writes wait for the shared writer lease"; R1/R2 test/embed/backlog.test.ts and test/embed/variant-backlog.test.ts write-turn tests; R2 test/serve/embed-scheduler.test.ts backoff/park/deferred tests; R3 detach integration "SIGTERM stops a resident blocked by an unleased SQLite writer" and test/core/shutdown-budget.test.ts; R4 detach integration "report a hung resident within a bounded time" and test/serve/resident-health.test.ts; R7 detach integration afterEach helper scan.

Follow-up (not built): a resident does not start a pass for a backlog that exists at startup (in fn-190 R2).

stage: impl-review - ran [round 1 NEEDS_WORK (2 findings fixed) .. round 2 SHIP]
Tier: session (intelligent, investigation-first)
## Evidence
- Commits: 31da39cc0246a5ff35acf3cb13943b9fcdec6efd, f25faa3d8b9a0c8685b2ba45c90331442044c189, 7cb2c2042182f9165a751b4d9cdd97e25f1907be
- Tests: bun test (5755 pass, 0 fail), bun test test/cli/detach.integration.test.ts (19 pass; new lease, SIGTERM, hung-status tests red on base), bun test test/embed test/serve test/core test/spec, bun run lint:check, bun run docs:verify, gno.sh: bun run check, bun run typecheck, bun run test (430 pass), bun run build
- PRs: