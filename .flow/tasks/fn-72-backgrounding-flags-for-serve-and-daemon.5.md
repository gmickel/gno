# fn-72-backgrounding-flags-for-serve-and-daemon.5 Integration tests: detach, status, stop, stale, double-start

## Description

End-to-end tests that actually spawn detached subprocesses and exercise the full lifecycle.

**Size:** M
**Files:**

- `test/cli/detach.integration.test.ts` (new)

## Approach

- Use the `Bun.spawn({ cmd: ["bun", "src/index.ts", ...], cwd: PROJECT_ROOT, env })` pattern from `test/cli/concurrency.test.ts:44-50`.
- Each test gets its own temp dir via `mkdtemp` and sets `GNO_DATA_DIR` so pid/log paths are isolated.
- Test cases:
  1. `serve --detach` → pid-file exists → HTTP GET `/` returns 200 → `serve --status` shows running → `serve --stop` exits 0 → pid-file removed.
  2. `daemon --detach --no-sync-on-start` → pid-file exists → `daemon --status` shows running → `daemon --stop` exits 0.
  3. Double-start guard: `serve --detach` twice → second exits 1 with "already running". Note: the second call may also fail with the start-lock error ("another serve start is in progress ... .startlock") if it races inside the spawn window; both are valid VALIDATION errors. <!-- Updated by plan-sync: fn-72.2 added the atomic start-lock sidecar -->
  4. Stale pid-file: write a pid-file pointing at a dead PID → `serve --status` returns "not running" (exit 3) → `serve --detach` succeeds and overwrites. Make sure the stale pid-file is schema-valid (positive integer pid, cmd in {serve, daemon}, non-empty version string, parseable ISO `started_at`, port null or int 1..65535). `readPidFile` now rejects malformed files with `CliError("RUNTIME")` rather than silently treating them as stale. <!-- Updated by plan-sync: fn-72.2 added strict pid-file validation — malformed files throw RUNTIME instead of being treated as absent -->
  5. SIGKILL fallback: spawn a detached serve that ignores SIGTERM → `--stop` eventually sends SIGKILL. (Accept a slower test; real-world timeout.)
  6. `--stop` with no pid-file: exits 3 silently. No `--json` envelope and no error envelope on stderr at all — `runServeStop` throws `CliError("NOT_RUNNING", ..., { silent: true })`. Assert `stderr === ""` AND exit code 3, for both serve and daemon. <!-- Updated by plan-sync: fn-72.3 confirmed the silent path empties stderr entirely, not just JSON -->
  7. `--json` gating: `serve --detach --json`, `serve --stop --json`, and `daemon --detach --json` must each exit 1 (VALIDATION) with the message `--json is only supported with gno serve --status` (or the daemon equivalent). Per-subcommand local `--json` plus `globals.json` are both checked. <!-- Updated by plan-sync: fn-72.3 added explicit --json gating; fn-72.4 inherits it -->
  8. `--status` NOT_RUNNING JSON envelope shape: when no live process exists AND a foreign-live pid is present, the NOT_RUNNING stderr envelope's `details.foreign_live` field carries `pid`, `recorded_version`, `current_version`. When no foreign-live is present, `details` is undefined. Validate against the error-envelope schema. <!-- Updated by plan-sync: fn-72.3 routes foreign-live metadata through CliError.details so JSON-mode stderr is a single envelope -->
  9. `--status` exit code: when `running:false` (stale, missing pid-file, or foreign-live), exit code is **3 (NOT_RUNNING)**, not 0. Stdout still carries the schema-conformant payload. <!-- Updated by plan-sync: fn-72.3 throws NOT_RUNNING after writing stdout so the schema stays clean and the exit code propagates -->
  10. Sentinel-flag invisibility: `serve --help` and `daemon --help` stdout must not contain the literal sentinel string (`--__detached-child`). Cheap regex check; pins the `Option#hideHelp()` call from fn-72.3. <!-- Updated by plan-sync: fn-72.3 hides the sentinel from --help via Commander -->
  11. `--detach` strips the flag before re-exec: spawn `serve --detach`, then read the live child's argv via `/proc/<pid>/cmdline` (Linux) or `ps -o args= -p <pid>` (macOS). Argv must contain the sentinel and must NOT contain `--detach`, otherwise the child would re-spawn itself. Skip on Windows. <!-- Updated by plan-sync: fn-72.3 added stripDetachFlag to prevent infinite re-spawn -->
  12. Pid-file unlink on clean shutdown: spawn `serve --detach`, send SIGINT or SIGTERM to the child, then assert the pid-file is gone after the child exits. Covers the `installPidFileCleanup` SIGINT/SIGTERM/beforeExit handlers. <!-- Updated by plan-sync: fn-72.3 wired sync unlinkSync via installPidFileCleanup -->
  13. Concurrent `--status`/`--stop` don't trip the start-lock: spawn `serve --detach`, then run 3-5 `serve --status` and `serve --stop` invocations in parallel against the same data dir. None should error with "another serve start is in progress" — the start-lock is only held inside `spawnDetached`. <!-- Updated by plan-sync: fn-72.3 confirmed status/stop branches don't acquire the start-lock -->
  14. **Live-foreign**: write a valid pid-file whose `pid` points at a live process we control (e.g. `sleep 60`) but whose `version` string is not the current `VERSION` → `serve --status` should mark running false via the kindMatches/versionMatches cross-check; `serve --stop` should exit 1 (`VALIDATION`) WITHOUT signalling the foreign pid; `serve --detach` should refuse to start. Verify the foreign process is still alive after `--stop`. <!-- Updated by plan-sync: fn-72.2 added foreign-live StopOutcome + versionMatchesPidFile cross-check; this behavior needs integration coverage -->
  15. Start-lock recovery: drop a stale `.startlock` file (mtime >30s old) in the data dir → `serve --detach` should auto-unlink it and succeed; a fresh lock-file (<30s old) should cause the second detach to fail fast with the start-lock VALIDATION error. <!-- Updated by plan-sync: fn-72.2 added start-lock staleness recovery -->
  16. **Windows-only**: `serve --detach` → exits 1 with clean `VALIDATION` error message referencing WSL.

- Cases 1-15: skip on `process.platform === "win32"`. <!-- Updated by plan-sync: renumbered after fn-72.3 added gating/sentinel/strip/cleanup/concurrency cases -->
- Case 16: runs only on `process.platform === "win32"`. <!-- Updated by plan-sync: renumbered Windows-only case from 9 to 16 -->
- Cases 6, 7, 9, 10 are also runnable on Windows (no detached child needed) — they exercise CLI parsing + error-envelope shape; opt them in if cheap. <!-- Updated by plan-sync: fn-72.3 added several pure-CLI checks that don't need a real detach -->

- Use 20s timeouts for each test (repo convention for win32 — see existing concurrency tests).
- Clean up via `safeRm` from `test/helpers/cleanup.ts` in `afterEach`. Make sure the `.startlock` sidecar file gets cleaned too — `spawnDetached` releases it on both success and failure, but a crashed test may leave one behind.

## Investigation targets

**Required:**

- `test/cli/concurrency.test.ts:44-50` — subprocess spawn template
- `test/helpers/cleanup.ts` — `safeRm`, tmpdir helpers
- `src/cli/detach.ts` — the API under test

**Optional:**

- `test/cli/daemon.test.ts` — existing daemon unit tests using `DaemonDeps` mocks
- `test/cli/daemon-flags.test.ts` — fn-72.4 unit-level coverage of the daemon flag wiring (action routing without booting the runtime); the integration suite should cover only the behaviors that need a real subprocess. <!-- Updated by plan-sync: fn-72.4 added 12 unit-level flag tests; integration tests should not duplicate them -->
- `test/cli/serve-flags.test.ts` — fn-72.3 unit-level coverage of the serve flag wiring; same dedup guidance. <!-- Updated by plan-sync: fn-72.3 added serve flag unit tests; integration tests should not duplicate them -->
- `test/cli/detach-argv.test.ts` — fn-72.4 regression tests for `resolveCliArgv()` (the per-invocation `Command.rawArgs` path that replaced the process-global capture). The detach-strip-flag integration case (case 11) exercises the same code path end-to-end via `/proc/<pid>/cmdline`. <!-- Updated by plan-sync: fn-72.4 fixed a process-state-taint bug in the detach argv source; the regression is covered at the unit level — integration just re-confirms it through a real subprocess -->

## Key context

- Integration tests are slower than unit tests; keep the suite under ~30s total on macOS/Linux.
- Windows suite only needs the one clean-error case — very fast.

<!-- Updated by plan-sync: removed duplicated/stale Approach + Investigation + Key-context sections (the upper sections above are the live versions; these were carried over from an earlier task draft and contradicted the renumbered cases). -->

## Acceptance

- [ ] Cases 1-15 pass on macOS + Linux (skip Windows-only on win32) <!-- Updated by plan-sync: fn-72.3 added gating/sentinel/strip/cleanup/concurrency cases; renumbered from 1-8 -->
- [ ] Case 16 (Windows clean error) passes on Windows CI <!-- Updated by plan-sync: renumbered Windows-only case from 9 to 16 -->
- [ ] Sentinel string `--__detached-child` does NOT appear in `serve --help` or `daemon --help` output (case 10) <!-- Updated by plan-sync: fn-72.3 hides the sentinel via Option#hideHelp() -->
- [ ] `--json` outside `--status` exits 1 with VALIDATION (case 7) <!-- Updated by plan-sync: fn-72.3 added explicit --json gating -->
- [ ] `--stop` with no pid-file leaves stderr empty (case 6, silent NOT_RUNNING) <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode -->
- [ ] Tests isolated via `GNO_DATA_DIR` tmp dirs — no writes to real data dir
- [ ] `bun test test/cli/detach.integration.test.ts` runs under 30s on macOS/Linux, under 5s on Windows
- [ ] No leaked subprocesses after suite
- [ ] No leaked `.startlock` sidecar files after suite

## Done summary

Added `test/cli/detach.integration.test.ts` covering all 16 task-5 cases end-to-end: real `bun src/index.ts` subprocess spawning, full lifecycle (detach → http ready → status → stop → cleanup), SIGKILL fallback, foreign-live + start-lock recovery, --json gating, sentinel invisibility, /proc-or-`ps` argv inspection for the strip-detach assertion, and the Windows VALIDATION clean-error case. Suite runs in ~25-30 s on macOS (well under the 30 s budget); GNO_OFFLINE=1 + per-test mkdtemp keeps it hermetic. Codex review: SHIP after one Major fix (case 8 was missing the win32 skip).

## Evidence

- Commits: 2fa0f3a55c1f6e2ec90c9e6d4e6dafc4fe9e7864, 64649eb7e33d66056588fe3f1e2abd660653c6a3
- Tests: bun test test/cli/detach.integration.test.ts, bun test test/cli/detach.integration.test.ts test/cli/detach.test.ts test/cli/detach-argv.test.ts test/cli/serve-flags.test.ts test/cli/daemon-flags.test.ts, bun run lint:check
- PRs:
