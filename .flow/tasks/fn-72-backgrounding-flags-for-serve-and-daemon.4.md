# fn-72-backgrounding-flags-for-serve-and-daemon.4 Wire detach/status/stop flags into gno daemon

## Description

Add the same five flags to `gno daemon`, routing through the shared `src/cli/detach.ts`.

**Size:** M
**Files:**

- `src/cli/program.ts` (`wireDaemonCommand` around L2195-2217)
- `src/cli/commands/daemon.ts`

## Approach

- Mirror the flag wiring and mode-branching from fn-72.3.
- `resolveProcessPaths("daemon")` for default pid/log.
- Daemon status payload has no `port` field (daemon is headless) — schema allows `port: null`.
- The existing `createSignalPromise` at `src/cli/commands/daemon.ts:34-64` already handles SIGTERM/SIGINT; extend it to unlink the pid-file when running as a detached child.
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
