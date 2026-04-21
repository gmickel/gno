# fn-72-backgrounding-flags-for-serve-and-daemon.4 Wire detach/status/stop flags into gno daemon

## Description

Add the same five flags to `gno daemon`, routing through the shared `src/cli/detach.ts`.

**Size:** M
**Files:**

- `src/cli/program.ts` (`wireDaemonCommand` around L2195-2217)
- `src/cli/commands/daemon.ts`

## Approach

- Mirror the flag wiring and mode-branching from fn-72.3 — same `spawnDetached({ kind: "daemon", ... })` / `statusProcess({ kind: "daemon", pidFile, logFile })` / `stopProcess({ kind: "daemon", pidFile })` / `verifyPidFileMatchesSelf({ pidFile })` / `inspectForeignLive({ kind: "daemon", pidFile })` shape. <!-- Updated by plan-sync: fn-72.2 helpers all take kind + return StopOutcome union -->
- `resolveProcessPaths("daemon", { pidFile: opts.pidFile, logFile: opts.logFile, cwd: process.cwd() })` for default pid/log.
- Daemon status payload has no `port` field (daemon is headless) — schema allows `port: null`, and `statusProcess` already forces `port: null` when `kind === "daemon"` regardless of what's in the pid-file. No caller action needed. <!-- Updated by plan-sync: fn-72.2 statusProcess normalizes port to null for daemon -->
- When `stopProcess` returns `{ kind: "foreign-live", pid, payload }`, throw `CliError("VALIDATION")` with the operator guidance from the payload — do NOT attempt `process.kill` on that pid; identity can't be proven across a gno version mismatch. <!-- Updated by plan-sync: fn-72.2 added foreign-live StopOutcome variant -->
- The existing `createSignalPromise` at `src/cli/commands/daemon.ts:34-64` already handles SIGTERM/SIGINT; extend it to unlink the pid-file when running as a detached child.
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
- [ ] `gno daemon --stop` SIGTERMs gracefully; exits 3 when not running
- [ ] Mutex + double-start guards behave identically to serve
- [ ] Existing `--no-sync-on-start` still works
- [ ] Detached-child unlinks pid-file on clean shutdown
- [ ] **LLM-thread hazard validated:** manually run `gno daemon --detach --no-sync-on-start` with at least one configured collection and confirm the parent exits within the 1s budget while `node-llama-cpp` is reachable. Record outcome in done summary; if parent hangs, restructure detach to happen at the top-level program action before Commander dispatch.
- [ ] `bun run lint:check && bun test test/cli/daemon.test.ts` green

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
