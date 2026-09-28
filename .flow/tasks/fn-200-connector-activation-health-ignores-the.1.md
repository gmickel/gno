---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-200-connector-activation-health-ignores-the.1 Implement connector activation health ignores the display cap

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Connector activation completeness is now decided from every collection/target pair instead of the listed 64: every pair is read from cached receipts, the unlisted ones are counted by outcome in the additive `connectorProjection.omitted` field, and `isConnectorActivationComplete`, `gno doctor`, `gno status`, REST `/api/status` and the Web UI connector check all decide from listed pairs plus those counts. The unreachable 16-target cap was removed (catalog has 7 targets); R4/R5 decisions and before/after timings are recorded in the spec.

stage: impl-review - skipped(config: REVIEW_MODE=none)

Tests (R-IDs):
- R1: test/core/activation-status.test.ts "decides connector completeness from every pair past the display cap: all passing" (red on base a305f4ba, green on head) and ": an unlisted failure" (failing pair c69 beyond the 64 listed -> incomplete)
- R2: test/cli/status.test.ts, test/cli/doctor.test.ts, test/serve/public/components/BootstrapStatus.test.tsx (omitted summary lines; unevaluated truncation still fails closed)
- R3: test/serve/api-status.test.ts (truncated all-pass evaluated projection -> ok/healthy), test/serve/public/components/HealthCenter.test.tsx (unlisted failure -> error)
- R4/R5: recorded in the spec ("Decisions and measurements"): status median 148 ms base vs 139 ms head on 25 collections x 7 targets (175 pairs)

Defect route:
- prior fixes: git log on activation-status/activation-connector-health/activation-health (only 31e02124 #134 introduction and 8c63bcf8 #278, neither changes the cap); open PRs: only dependabot #181/#182, unrelated; gh issues "connector truncated": none; memory bug track "connector projection truncated": none
- diagnosis: eliminated "a listed pair failed" (repro asserts all 64 listed pairs passed, still incomplete); eliminated "total miscounted" (total 70 = 70 collections x 1 target as expected); confirmed `isConnectorActivationComplete` returns false solely on `connectorProjection.truncated` (live base run: 175 pairs, all connector_not_configured, doctor UNHEALTHY with "64 of 175 ... projected", status Health: DEGRADED)
- introduced by: 31e02124 feat: prove retrieval readiness end to end (#134) - cap and fail-closed truncation were part of the original design; bisect skipped: no known-good revision
- base: at a305f4ba (repro commit) "all passing" case fails (isConnectorActivationComplete false, expected true) | head: at 489da638 all activation tests pass (16/16 in core activation files)
- live: throwaway index, 25 collections x 7 targets (175 pairs). Base 0a9b2bb8: `gno status` Health: DEGRADED, `gno doctor` UNHEALTHY with connector-activation warn "no result is claimed". Head: `gno status` Health: OK with "Connector projection: 64/175 target/collection checks shown; 111 omitted (111 not configured or not verifiable)", `gno doctor --json` healthy:true. Web UI not driven (conductor QA stage).

Gates: `bun run lint:check` green; `bun run docs:verify` green; `bun test` full suite - first run 6047 pass / 2 fail (SPA snapshot stale -> fixed by `bun run build:spa`, committed; ModelManager test fails only with GNO_LLAMA_GPU=false in env, passes without). Final run under load avg ~13: 6043 pass / 6 fail, all timeouts in unrelated files; test/store/links.test.ts and test/cli/commands/audit.test.ts fail identically on base 0a9b2bb8 under the same load; test/sessions/service.test.ts and test/eval/acceptance/fixtures.test.ts pass on head when rerun alone. No unrelated file is touched by this diff.

gno.sh follow-up (not edited): src/lib/gno-docs.tsx lines ~3179-3182 (doctor/status activation), ~4322-4325 (status passive connectors) and ~7289-7293 (troubleshooting) say omitted target/collection pairs have no result and health stays non-green. Suggested wording: "Only the first 64 target/collection pairs are listed, but every pair is checked from saved results. `connectorProjection.omitted` counts the unlisted pairs as passed, failed, incomplete or not applicable, and connector health is decided from all of them: a large vault whose checks all pass is healthy, and a failed or pending check beyond the list still shows."

Follow-up: temp worktree /home/gordon/.cache/gno-fn200-base (detached at 0a9b2bb8, plus a node_modules symlink) could not be removed because the dcg hook blocked unlink/mv; remove with `git worktree remove --force /home/gordon/.cache/gno-fn200-base`.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: a305f4ba384b9910369d87f4369248c68d9a867e, 489da6380393eccc243e5e47372bcac6004c80e9
- Tests: bun run lint:check, bun run docs:verify, bun test (6043 pass / 6 fail: load timeouts, links+audit fail identically on base), bun test test/core/activation-status.test.ts (repro red at a305f4ba, green at head)
- PRs: