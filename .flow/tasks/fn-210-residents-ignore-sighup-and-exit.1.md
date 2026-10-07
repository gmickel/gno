---
satisfies: [R1, R2, R3]
---
# fn-210-residents-ignore-sighup-and-exit.1 Shut residents down gracefully on SIGHUP

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno serve` and `gno daemon` had no SIGHUP handler, so a closed terminal or logout killed them immediately: in-flight work was cut off and the write-lease holder note stayed behind until the next start. Both now register SIGHUP next to SIGINT/SIGTERM and run the same graceful shutdown (`src/serve/server.ts`, `createSignalPromise` in `src/cli/commands/daemon.ts`). Detached residents run in their own session and are unchanged. Docs: DAEMON.md shutdown section, CLI.md foreground note, CHANGELOG.

Defect route:
- prior fixes: none
- diagnosis: grep showed no SIGHUP handler anywhere in src; fn-205's soak run (signals seed 3) failed I3 "SIGHUP while mid-burst: write-lease holder sidecar left"
- introduced by: skipped: original behaviour
- base: aec2ee0e test fails (serve and daemon exit by signal SIGHUP) | head: d3df44cc passes (exit 0, owner lock free)
- live: soak torture signals seed 3: every SIGHUP case passes I3 (locks, holder sidecar, pid file, start-lock, port released) and I5 (SIGHUP -> exit 0 after 20 ms idle, 4.4 s mid-burst)

R1 SIGHUP handled like SIGTERM. R2 test/serve/resident-sighup.integration.test.ts. R3 signals class passes I3 for SIGHUP.

Unrelated in that run: I4 one probe at 281 ms in SIGKILL/mid-embed right after the crash restart (startup recovery), filed separately.

Full gate: lint 0 warnings; bun test 6117 pass, 0 fail.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: aec2ee0e58205472e35f4128c4604be1dcc251a4, d3df44ccf08bb75acbb528d8bca91e1328fcb1d3
- Tests: bun run lint:check && bun test
- PRs: