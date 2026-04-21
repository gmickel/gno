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
  6. `--stop` with no pid-file → exits 3 silently (no `--json` envelope — per `spec/cli.md` Error Output section, `--stop` does not accept `--json`).
  7. **Live-foreign**: write a valid pid-file whose `pid` points at a live process we control (e.g. `sleep 60`) but whose `version` string is not the current `VERSION` → `serve --status` should mark running false via the kindMatches/versionMatches cross-check; `serve --stop` should exit 1 (`VALIDATION`) WITHOUT signalling the foreign pid; `serve --detach` should refuse to start. Verify the foreign process is still alive after `--stop`. <!-- Updated by plan-sync: fn-72.2 added foreign-live StopOutcome + versionMatchesPidFile cross-check; this behavior needs integration coverage -->
  8. Start-lock recovery: drop a stale `.startlock` file (mtime >30s old) in the data dir → `serve --detach` should auto-unlink it and succeed; a fresh lock-file (<30s old) should cause the second detach to fail fast with the start-lock VALIDATION error. <!-- Updated by plan-sync: fn-72.2 added start-lock staleness recovery -->
  9. **Windows-only**: `serve --detach` → exits 1 with clean `VALIDATION` error message referencing WSL.
- Cases 1-8: skip on `process.platform === "win32"`.
- Case 9: runs only on `process.platform === "win32"`.
- Use 20s timeouts for each test (repo convention for win32 — see existing concurrency tests).
- Clean up via `safeRm` from `test/helpers/cleanup.ts` in `afterEach`. Make sure the `.startlock` sidecar file gets cleaned too — `spawnDetached` releases it on both success and failure, but a crashed test may leave one behind.

## Investigation targets

**Required:**

- `test/cli/concurrency.test.ts:44-50` — subprocess spawn template
- `test/helpers/cleanup.ts` — `safeRm`, tmpdir helpers
- `src/cli/detach.ts` — the API under test

**Optional:**

- `test/cli/daemon.test.ts` — existing daemon unit tests using `DaemonDeps` mocks

## Key context

- Integration tests are slower than unit tests; keep the suite under ~30s total on macOS/Linux.
- Windows suite only needs the one clean-error case — very fast.

## Approach

- Use the `Bun.spawn({ cmd: ["bun", "src/index.ts", ...], cwd: PROJECT_ROOT, env })` pattern from `test/cli/concurrency.test.ts:44-50`.
- Each test gets its own temp dir via `mkdtemp` and sets `GNO_DATA_DIR` so pid/log paths are isolated.
- Test cases:
  1. `serve --detach` → pid-file exists → HTTP GET `/` returns 200 → `serve --status` shows running → `serve --stop` exits 0 → pid-file removed.
  2. `daemon --detach --no-sync-on-start` → pid-file exists → `daemon --status` shows running → `daemon --stop` exits 0.
  3. Double-start guard: `serve --detach` twice → second exits 1 with "already running".
  4. Stale pid-file: write a pid-file pointing at a dead PID → `serve --status` returns "not running" (exit 3) → `serve --detach` succeeds and overwrites.
  5. SIGKILL fallback: spawn a detached serve that ignores SIGTERM (use a mock child via a test harness flag, or accept slower test using a real graceful timeout) → `--stop` eventually sends SIGKILL.
  6. `--stop` with no pid-file → exits 3 silently (no error envelope).
- Use 20s timeouts for each test (repo convention for win32 — see existing concurrency tests).
- Clean up via `safeRm` from `test/helpers/cleanup.ts` in `afterEach`.

## Investigation targets

**Required:**

- `test/cli/concurrency.test.ts:44-50` — subprocess spawn template
- `test/helpers/cleanup.ts` — `safeRm`, tmpdir helpers
- `src/cli/detach.ts` — the API under test

**Optional:**

- `test/cli/daemon.test.ts` — existing daemon unit tests using `DaemonDeps` mocks

## Key context

- Integration tests are slower than unit tests; keep the suite under ~30s total.
- Use `process.platform === "win32"` to skip SIGKILL-path test on Windows (see fn-72.6).

## Acceptance

- [ ] Cases 1-8 pass on macOS + Linux (skip on win32) <!-- Updated by plan-sync: fn-72.2 added foreign-live + start-lock behaviors that need integration coverage -->
- [ ] Case 9 (Windows clean error) passes on Windows CI <!-- Updated by plan-sync: renumbered 7 → 9 after adding live-foreign + start-lock cases -->
- [ ] Tests isolated via `GNO_DATA_DIR` tmp dirs — no writes to real data dir
- [ ] `bun test test/cli/detach.integration.test.ts` runs under 30s on macOS/Linux, under 5s on Windows
- [ ] No leaked subprocesses after suite
- [ ] No leaked `.startlock` sidecar files after suite

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
