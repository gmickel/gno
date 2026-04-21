# fn-72-backgrounding-flags-for-serve-and-daemon.3 Wire detach/status/stop flags into gno serve

## Description

Add the five new flags to `gno serve` and route through `src/cli/detach.ts`.

**Size:** M
**Files:**

- `src/cli/program.ts` (`wireServeCommand` around L2220-2241)
- `src/cli/commands/serve.ts`

## Approach

- Use Commander's `addOption(new Option(...).conflicts([...]))` to make `--detach`, `--status`, `--stop` mutually exclusive. See Commander v14 docs — the project is on `commander ^14.0.2`.
- In the action handler, branch early based on which mode was requested:
  - `--status` → call `statusProcess()`, format per `getGlobals().json`, return.
  - `--stop` → call `stopProcess()`, handle `NOT_RUNNING` exit 3, return.
  - `--detach` → call `guardDoubleStart()`, then `spawnDetached()`, print `PID <n> listening on http://localhost:<port>`, return.
  - **Detached-child mode** (`--__detached-child` flag set by parent spawn): proceed with normal `startServer()` flow. Install the daemon-style SIGTERM/SIGINT handler that unlinks the pid-file on shutdown.
  - Neither set → normal foreground behavior (unchanged).
- Pid-file and log-file defaults: `resolveProcessPaths("serve")`.
- Status payload includes port from the running server's pid-file metadata.

## Investigation targets

**Required:**

- `src/cli/program.ts:2220-2241` — `wireServeCommand` current shape
- `src/cli/commands/serve.ts` — delegates to `startServer` from `src/serve`
- `src/cli/detach.ts` — helper signatures from fn-72.2
- `src/cli/options.ts:146-175` — `parsePositiveInt` for `--port`

**Optional:**

- `src/serve/server.ts:154-164` — existing `AbortController` shutdown (must unlink pid-file on shutdown path when detached-child)
- `src/cli/commands/mcp/status.ts:144-222` — json/terminal status output reference

## Key context

- The `--__detached-child` sentinel flag must **not** appear in `--help`; hide with Commander's `Option#hideHelp()`.
- Graceful shutdown: the detached-child serve must unlink its own pid-file in the SIGTERM handler before exiting.

## Acceptance

- [ ] `gno serve --detach` spawns a background process; parent exits 0 with `PID X listening on http://localhost:PORT`
- [ ] `gno serve --status` shows running/pid/port/uptime; `--json` validates against the schema
- [ ] `gno serve --stop` SIGTERMs gracefully; exits 3 when not running
- [ ] `--detach` / `--status` / `--stop` conflict errors use Commander's native message
- [ ] `gno serve --detach` twice → second call errors with "already running"
- [ ] Detached-child unlinks pid-file on clean shutdown
- [ ] **LLM-thread hazard validated:** manually run `gno serve --detach` with at least one configured collection and confirm the parent exits within the 1s budget while `node-llama-cpp` is reachable in the module graph. Record outcome in done summary; if parent hangs, restructure detach to happen at the top-level program action before Commander dispatch.
- [ ] `bun run lint:check && bun test` green

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
