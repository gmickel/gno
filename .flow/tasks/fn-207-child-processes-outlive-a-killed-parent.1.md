---
satisfies: [R1, R2, R3, R4]
---
# fn-207-child-processes-outlive-a-killed-parent.1 Bound child processes by their parent

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Three child processes outlived a killed parent; each now has an event-driven stdin lifeline (works on Linux, macOS and Windows, survives SIGKILL, no polling timer):

1. Desktop shell -> serve. New `desktop/electrobun-shell/src/bun/serve-process.ts`: serve is spawned with a stdin pipe and `GNO_PARENT_LIFELINE=stdin`; new `src/serve/parent-lifeline.ts` makes serve shut down as on SIGTERM when stdin reaches EOF (opt-in only, so `nohup gno serve` is unchanged; the env var is removed so serve's own children never inherit it). The shell's quit (before-quit, SIGINT/SIGTERM) now waits for serve after SIGTERM and escalates to SIGKILL after 15 s. serve's shutdown wait also resolves when shutdown was triggered before the wait started.
2. Session import child (`src/sessions/import-child.ts`). The request is now one stdin line and the pipe stays open; the child exits on EOF before it has answered. `killImportChildren()` runs at the start of resident shutdown; each import has a 30 min timeout.
3. `updateCmd` (`src/ingestion/sync.ts`). Runs under a small sh wrapper that leads its own process group (detached spawn) and blocks a subshell on gno's stdin (through fd 3, since an async list's stdin is /dev/null); when gno exits or is killed the whole group is killed. New optional collection field `updateCmdTimeoutMs` (default 10 min): SIGTERM to the group, SIGKILL after 5 s. Documented in CONFIGURATION.md.

The soak stand-in for the desktop shell mirrors the new spawn shape. Shell README and CHANGELOG updated.

Defect route:
- prior fixes: none for these paths (file-child.ts already uses PDEATHSIG + between-step checks for the file processor; reused the idea, not the code)
- diagnosis: each failure reproduced by a test that fails on main: serve keeps running after its launcher is SIGKILLed; an import child keeps importing (400-rollout fixture, ~6 s) after its parent is SIGKILLed; `sleep 600.x` updateCmd survives gno index SIGKILL/SIGTERM and blocks indexing 30 s+ without a timeout
- introduced by: skipped: original behaviour, no known-good revision
- base: e70d01e2/0f75f9e7/f4ffe493 tests fail on main (lifeline 1/2 fail, import parent-death fails, updateCmd 3/3 fail) | head: all pass (parent-lifeline 2, serve-process 4, import-child-lifecycle 3, update-cmd-lifetime 3)
- live: soak torture desktop-shell-kill, session-import-kill, update-cmd (seed 4, contained): I2 5/5 pass, I3 pass; updateCmd confirmed running before SIGKILL and SIGTERM

R1 shell->serve lifeline + awaited, escalating quit. R2 import child exits on parent death, killed on shutdown, 30 min timeout. R3 updateCmd process group killed on exit/signal/timeout, configurable via updateCmdTimeoutMs. R4 the three soak classes pass I2.

Full gate: lint 0 warnings; bun test 6086 pass, 0 fail.

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: e70d01e23b581347c9916e4778d1012a2a101b8c, f71dd0f03895f2053f0800c8cdb59ee5df41a228, 0f75f9e75b0d62e27649ef0deecaaeee57a058e3, 87711104d237060f88caf8a8266e543148403c08, f4ffe4930bdc065a7e17b08cdb00d3138ffd8795, 4784b9e1f988b094d03c083f0f76eb37ca88c91a, e58e9c62078a67a7e3d74ec2cff872a684958216
- Tests: bun run lint:check && bun test
- PRs: