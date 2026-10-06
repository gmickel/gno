---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-203-isolated-soak-and-chaos-harness-for.1 Implement isolated soak and chaos harness

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Built `bun run soak` (scripts/soak/): a sealed sandbox (own HOME/XDG/GNO dirs, offline, loopback fake model server with injectable faults, run-marker env on every child), seeded actors (file churn with tracked expected state, REST readers, stdio MCP clients incl. long-lived and killed mid-call, CLI writers, raw-socket SSE subscribers), a 1 s process monitor (tagged-tree CPU/ctx switches/RSS/fds/zombies, status probes, DB/ingest_errors/log growth), nine invariants with thresholds in config.ts, tiers smoke/torture/soak, report.json/report.md with --replay, and --contain (Linux PID namespace with bash as reaping PID 1). AGENTS.md scripts table and usage updated; package script `soak`.

R1 sandboxed: env built from scratch (PATH + sandbox dirs only); runs used temp roots; thor's live gno untouched. R2: marker sweep finds grandchildren (unit test), teardown kills and reports leftovers, --contain verified (torture runs under unshare). R3: I1-I9 independent checks, thresholds in one block. R4: seeded rng forks, --replay from report.json. R5: torture classes reach every fn-203 gap (failing collection, lease held, signals incl. SIGHUP, embed faults, sleep/wake, desktop-shell kill, updateCmd kill, session-import kill, SSE flood, MCP lifecycle, stale locks, config edits; macOS ps sampler and disk-full are explicit skips with reasons). R6: smoke runs in 4.3 min on Linux; it currently fails only on real findings (I5 fn-206, I4 fn-208), expected to pass once those land. R7: findings filed as bug memory + specs fn-204..fn-209; no threshold loosened.

Validation runs (local): smoke x5, torture x2 (+ update-cmd rerun), each harness defect found was fixed (zombie accounting under PID-1 harness, class cascade, overlapping timed-out class, fetch-pool starvation, pid-file shape, updateCmd egress, idle-window child snapshot, MCP startup error reporting, integrity check via adapter).

Findings (confirmed): fn-204 stdio mcp "database is locked" under resident writes; fn-205 serve does not reconcile offline changes (probe: 50 vs 69); fn-206 detached daemon ignores SIGTERM during startup (3/3, 12.17 s SIGKILL); fn-207 serve/session-import child/updateCmd outlive killed parents; fn-208 status p99 0.3-5.8 s under load; fn-209 intermittent missed deletion (2 occurrences). Proved harmless in torture: write-lease held 3 min (lease probing bounded, idle CPU ok), SIGTERM/SIGINT/SIGHUP shutdown within budget, SSE flood fds return, stale pid/holder/tags locks recovered, MCP parent death (child exits).

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: b453899ff847b3a9a4de357b7059fe34dff2792b, f12d46bd234e4dd2edf1db0f7805b8f61f82a2e0, 39518145d62484e08db9d98f9679d74d3c4a80fa
- Tests: bun test test/soak, bun run soak --tier smoke --seed 2, bun run soak --tier torture --seed 3 --contain, bun run lint:check && bun test
- PRs: