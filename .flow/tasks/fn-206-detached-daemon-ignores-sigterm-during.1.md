---
satisfies: [R1, R2, R3]
---
# fn-206-detached-daemon-ignores-sigterm-during.1 Stop a detached resident cleanly during startup

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
A stop sent to a detached daemon or serve while it was still starting up (for example `--stop` right after `--detach` returned) was swallowed: the detached child's pid-file cleanup listener disabled the default SIGTERM/SIGINT action before the daemon/server installed its shutdown handler, so the process kept running and `--stop` SIGKILLed it after 12 s. The cleanup listener now exits (143/130) when no other handler for that signal is registered. `stopProcess` also removes the pid file after a confirmed exit when the target could not (killed before its listener existed, or SIGKILLed), only if the file still names the stopped pid. CHANGELOG Unreleased Fixed entry added.

Defect route:
- prior fixes: none (git log on src/cli/detach.ts and program.ts installPidFileCleanup; bug memory detached-daemon-ignores-sigterm-during filed by fn-203; no open PRs on the area)
- diagnosis: eliminated "daemon ignores SIGTERM" (a direct SIGTERM at 0/300/1000/3000 ms after --detach always exited in ~100 ms) and "zombie not reaped" (ps showed state Ssl, not Z, for the full 12 s); confirmed the swallow window: during `--stop` the daemon stayed alive (Ssl) for 12 s and its log never printed "Received SIGTERM", i.e. only the pid-file cleanup listener ran
- introduced by: skipped: no known-good revision
- base: 16d964e4 both new integration cases fail (Stopped ... SIGKILL after ~12.4 s, daemon and serve) | head: dc5d0212 passes 12/12 across 6 runs
- live: soak smoke (worktree, seed 2) I5 `daemon --stop: SIGTERM -> exit 0 after 188 ms` (was 12.17 s SIGKILL); I3 locks, holder sidecar, pid file, start-lock released

R1 fixed (startup SIGTERM exits within budget; locks and pid file released). R2 test/cli/detach.integration.test.ts "daemon/serve --stop right after --detach stops on SIGTERM without escalation". R3 soak smoke detach cycle passes I5.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 16d964e462577f2d1b3cac87f9947b801360827f, dc5d0212771e5811063a3f72b171ff957b6b04b8
- Tests: bun run lint:check && bun test
- PRs: