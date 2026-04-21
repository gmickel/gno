# fn-72-backgrounding-flags-for-serve-and-daemon.4 Wire detach/status/stop flags into gno daemon

## Description

Add the same five flags to `gno daemon`, routing through the shared `src/cli/detach.ts`.

**Size:** M
**Files:**

- `src/cli/program.ts` (`wireDaemonCommand` around L2195-2217)
- `src/cli/commands/daemon.ts`

## Approach

- Mirror the flag wiring and mode-branching from fn-72.3 — same `spawnDetached({ kind: "daemon", ... })` / `statusProcess({ kind: "daemon", pidFile, logFile })` / `stopProcess({ kind: "daemon", pidFile })` / `verifyPidFileMatchesSelf({ pidFile })` / `inspectForeignLive({ kind: "daemon", pidFile })` shape. <!-- Updated by plan-sync: fn-72.2 helpers all take kind + return StopOutcome union -->
- **Reuse the fn-72.3 pattern wholesale** (see `src/cli/program.ts:2225-2566`): split the action into `handleDaemonAction` + `runDaemonStatus` + `runDaemonStop` + `runDaemonDetach` helpers; lift `stripDetachFlag`, `installPidFileCleanup`, and `toCamelCase` to module scope (or import from a shared location) so the daemon wiring doesn't duplicate them. <!-- Updated by plan-sync: fn-72.3 introduced these helpers; fn-72.4 must reuse, not redefine -->
- **`--json` is gated to `--status` only** for daemon too. Add the local `--json` option on the daemon subcommand and throw `CliError("VALIDATION", "--json is only supported with `gno daemon --status`")` if `globals.json || cmdOpts.json` is set on any other branch. <!-- Updated by plan-sync: fn-72.3 introduced explicit --json gating; daemon must match -->
- **Defer port-style validation** of any non-management options the same way fn-72.3 defers `parsePositiveInt("port", ...)` — daemon has no `--port`, but `--no-sync-on-start` parsing should still only matter on the foreground/detached-child paths. Don't validate option semantics on `--status`/`--stop` branches.
- **Sentinel access pattern**: read the detached-child marker via `(cmdOpts as Record<string, unknown>)[toCamelCase(DETACHED_CHILD_FLAG)]` (Commander camel-cases `--__detached-child` to `__detachedChild`). Reuse the `toCamelCase` helper from `program.ts:2574-2578` rather than hard-coding the property name. <!-- Updated by plan-sync: fn-72.3 introduced the toCamelCase helper for sentinel lookup -->
- **`stripDetachFlag` is required** before re-exec — pass `stripDetachFlag(process.argv.slice(2))` as `argv` to `spawnDetached` so the child doesn't infinite-loop re-spawning itself. The fn-72.3 helper at `src/cli/program.ts:2542-2544` is daemon-agnostic; reuse it. <!-- Updated by plan-sync: fn-72.3 added stripDetachFlag to prevent infinite re-spawn -->
- **`--stop` no-process path uses `silent: true`** on the `CliError("NOT_RUNNING", ...)` so nothing hits stderr, matching fn-72.3 and `spec/cli.md`. The serve precedent: `throw new CliError("NOT_RUNNING", "...", { silent: true })`. <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode -->
- **`--status` NOT_RUNNING envelope** carries foreign-live metadata in `details.foreign_live` (`{ pid, recorded_version, current_version }`) so JSON-mode stderr stays a single envelope. In terminal mode, write a separate stderr warning before the throw. See `runServeStatus` at `src/cli/program.ts:2397-2471` for the exact shape. <!-- Updated by plan-sync: fn-72.3 routes foreign-live through CliError details rather than parallel stderr writes -->
- `resolveProcessPaths("daemon", { pidFile: opts.pidFile, logFile: opts.logFile, cwd: process.cwd() })` for default pid/log.
- Daemon status payload has no `port` field (daemon is headless) — schema allows `port: null`, and `statusProcess` already forces `port: null` when `kind === "daemon"` regardless of what's in the pid-file. No caller action needed. <!-- Updated by plan-sync: fn-72.2 statusProcess normalizes port to null for daemon -->
- When `stopProcess` returns `{ kind: "foreign-live", pid, payload }`, throw `CliError("VALIDATION")` with the operator guidance from `outcome.payload.version` vs the imported `VERSION` constant — do NOT attempt `process.kill` on that pid; identity can't be proven across a gno version mismatch. <!-- Updated by plan-sync: fn-72.2 added foreign-live StopOutcome variant; fn-72.3 surfaced the exact message shape -->
- The existing `createSignalPromise` at `src/cli/commands/daemon.ts:34-64` already handles SIGTERM/SIGINT; extend it to unlink the pid-file when running as a detached child. **Alternative considered:** the fn-72.3 serve path uses a separate `installPidFileCleanup(pidFile)` (one-shot SIGINT/SIGTERM/beforeExit + sync `unlinkSync`) instead of extending the runtime's signal pattern. Pick whichever lands cleaner with the existing daemon shape — both end up unlinking the pid-file before exit. <!-- Updated by plan-sync: fn-72.3 chose the installPidFileCleanup approach for serve; daemon may diverge if createSignalPromise is more natural -->
- When running as detached-child (sentinel `DETACHED_CHILD_FLAG` present in argv — imported from `src/cli/detach.ts`), call `verifyPidFileMatchesSelf({ pidFile })` BEFORE `startBackgroundRuntime` so we exit cleanly if the parent crashed mid-write. <!-- Updated by plan-sync: fn-72.2 shipped verifyPidFileMatchesSelf helper -->
- Keep `--no-sync-on-start` working.

## Investigation targets

**Required:**

- `src/cli/program.ts:2195-2217` — `wireDaemonCommand` current shape
- `src/cli/commands/daemon.ts:1-159` — full implementation including signal handling
- `src/cli/detach.ts` — helper signatures from fn-72.2

**Optional:**

- `src/serve/background-runtime.ts` — shared runtime both daemon and serve consume (from fn-55)

## Key context

- Keep `DaemonDeps` injection seam intact — existing tests mock `logger` and `startBackgroundRuntime`.
- The signal-handler extension should write "shutting down, unlinking pid-file" at verbose level only.
- Sentinel flag is exported as `DETACHED_CHILD_FLAG` from `src/cli/detach.ts` (value: `--__detached-child`). Hide with Commander's `Option#hideHelp()`. <!-- Updated by plan-sync: fn-72.2 exports the sentinel as a constant — reuse it, don't hard-code the string -->
- LLM-thread hazard was retired by the fn-72.2 ad-hoc spike (parent exits ~32ms even with `node-llama-cpp` adapter in the module graph). The remaining validation is confirming it holds when `startBackgroundRuntime` is wired up — native threads don't load until `ModelManager.getLlama()` fires, so detach-before-runtime-init should be safe. <!-- Updated by plan-sync: fn-72.2 retired the LLM-thread hazard flagged by the epic spec -->
- `spawnDetached`'s internal start-lock (`<pidFile>.startlock`) serializes concurrent `--detach` invocations — no need for caller-level serialization in the daemon action.

## Acceptance

- [ ] `gno daemon --detach` spawns a background process; parent exits 0 with `PID X`
- [ ] `gno daemon --status` shows running/pid/uptime; `--json` validates against the schema
- [ ] `gno daemon --stop` SIGTERMs gracefully; exits 3 when not running (silent stderr — no error envelope, matching serve) <!-- Updated by plan-sync: fn-72.3 routes the not-running stop branch through CliError silent mode -->
- [ ] `gno daemon --json` outside of `--status` throws VALIDATION (matches serve gating) <!-- Updated by plan-sync: fn-72.3 introduced explicit --json gating -->
- [ ] Mutex + double-start guards behave identically to serve
- [ ] Existing `--no-sync-on-start` still works
- [ ] Detached-child unlinks pid-file on clean shutdown
- [ ] LLM-thread hazard already validated for serve in fn-72.3 (parent exits ~30ms with `node-llama-cpp` reachable). Re-confirm for daemon by running `gno daemon --detach --no-sync-on-start` once with a configured collection; note the parent-exit time in the done summary. <!-- Updated by plan-sync: fn-72.3 retired the LLM-thread hazard for serve; daemon validation remains as a sanity check, not a gate -->
- [ ] `bun run lint:check && bun test test/cli/daemon.test.ts` green

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
