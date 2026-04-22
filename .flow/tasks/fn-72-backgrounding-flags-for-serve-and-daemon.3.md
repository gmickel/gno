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
  - `--status` → call `statusProcess({ kind: "serve", pidFile, logFile })`, format per `getGlobals().json`, return. Optionally pair with `inspectForeignLive({ kind: "serve", pidFile })` to surface operator-facing live-foreign warnings (live pid, matching kind, version mismatch) that the `process-status@1.0` schema can't encode. <!-- Updated by plan-sync: fn-72.2 added kind+logFile to statusProcess signature and shipped inspectForeignLive sidecar -->
  - `--stop` → call `stopProcess({ kind: "serve", pidFile })`; switch on the returned `StopOutcome` union — `"stopped"` → exit 0, `"not-running"` → throw `CliError("NOT_RUNNING")` (exit 3), `"timeout"` → throw `CliError("RUNTIME")`, `"foreign-live"` → throw `CliError("VALIDATION")` with the pid/version guidance from the payload. Do NOT attempt to signal the pid yourself when `stopProcess` returns `foreign-live`. <!-- Updated by plan-sync: fn-72.2 made stopProcess return a StopOutcome discriminated union instead of void -->
  - `--detach` → call `spawnDetached({ kind: "serve", argv, pidFile, logFile, port })` directly. `spawnDetached` acquires an internal start-lock and re-invokes `guardDoubleStart(pidFile, "serve")` under the lock, so callers do NOT need a separate guard call. Print `PID <n> listening on http://localhost:<port>`, return. <!-- Updated by plan-sync: fn-72.2 folded guardDoubleStart + atomic start-lock inside spawnDetached -->
  - **Detached-child mode** (`DETACHED_CHILD_FLAG` sentinel from `src/cli/detach.ts` — value `--__detached-child` — set by parent spawn): call `verifyPidFileMatchesSelf({ pidFile })` early; if it returns `false` the parent never registered us, exit cleanly rather than boot unmanaged. On success proceed with normal `startServer()` flow and install the daemon-style SIGTERM/SIGINT handler that unlinks the pid-file on shutdown. <!-- Updated by plan-sync: fn-72.2 exported DETACHED_CHILD_FLAG constant + verifyPidFileMatchesSelf helper (bounded child-side poll replaces the "assert pid === process.pid on first tick" sketch in the epic spec) -->
  - Neither set → normal foreground behavior (unchanged).
- Pid-file and log-file defaults: `resolveProcessPaths("serve", { pidFile: opts.pidFile, logFile: opts.logFile, cwd: process.cwd() })` — user-supplied `--pid-file`/`--log-file` pass through `toAbsolutePath` so `~` + relative paths both work.
- `guardDoubleStart` now requires `kind` as its second arg (`guardDoubleStart(pidFile, "serve")`). Only needed if you want to pre-validate before calling `spawnDetached` for a better error message; otherwise rely on `spawnDetached`'s internal call. <!-- Updated by plan-sync: fn-72.2 added kind param to guardDoubleStart -->
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

- The sentinel flag literal (`--__detached-child`, exported as `DETACHED_CHILD_FLAG` from `src/cli/detach.ts`) must **not** appear in `--help`; hide with Commander's `Option#hideHelp()`. Import and reference the constant rather than hard-coding the string. <!-- Updated by plan-sync: fn-72.2 exports the sentinel as a constant -->
- Graceful shutdown: the detached-child serve must unlink its own pid-file in the SIGTERM handler before exiting.
- `spawnDetached` throws `CliError("VALIDATION")` on Windows pointing at WSL — Commander's default error handler (via `runCli`) surfaces this cleanly, no extra wrapping needed.
- LLM-thread hazard was retired in fn-72.2 (ad-hoc spike confirmed parent exits ~32ms even with `node-llama-cpp` adapter lazy-imported). The remaining validation is confirming it still holds when `startServer` is actually wired up with a real collection — native threads don't load until `ModelManager.getLlama()` fires. <!-- Updated by plan-sync: fn-72.2 retired the LLM-thread hazard; the epic spec's earlier "still open" framing no longer applies -->
- `spawnDetached` has an internal start-lock sidecar (`<pidFile>.startlock`, O_CREAT | O_EXCL) that serializes concurrent `--detach` invocations in the same `GNO_DATA_DIR`. Stale locks (>30s) are auto-recovered. No caller action needed, but integration tests that concurrently spawn should be aware the second call gets a clear VALIDATION error rather than a silent race.
- If `spawnDetached` successfully spawns the child but then fails to write the pid-file, it synchronously reaps the orphan (SIGTERM → SIGKILL) before throwing `CliError("RUNTIME")`. No dangling processes on pid-file write failure.

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

Wired `--detach` / `--status` / `--stop` / `--pid-file` / `--log-file` into `gno serve` via the shared `src/cli/detach.ts` helper, with a hidden `--__detached-child` sentinel and pid-file unlink on SIGINT/SIGTERM/beforeExit. The five-flag mutex uses Commander's native `Option.conflicts()`; `--json` is gated to `--status` only and routes foreign-live metadata through `CliError.details` so JSON-mode stderr stays a single envelope.

Acceptance verified end-to-end on macOS: `--detach` parent exits ~30 ms with `node-llama-cpp` reachable in the module graph (LLM-thread hazard does not materialize); `--status` reports running/stopped with schema-conformant JSON and exit 3 when no live process; `--stop` SIGTERMs gracefully and exits 3 silently when nothing to stop; double-start blocked; pid-file unlinked on clean shutdown. 14 regression tests in `test/cli/serve-flags.test.ts`; full suite 1789 pass; lint clean.

Codex review note: reviewer repeatedly flagged absent daemon wiring. The epic's requirement-coverage table at `.flow/specs/fn-72-backgrounding-flags-for-serve-and-daemon.md:151` explicitly assigns R5 ("gno daemon wiring with all five flags + mutex") to task fn-72.4 (status: todo), not fn-72.3. The fn-72.3 task spec lists files limited to serve-only surfaces. Daemon parity will land in fn-72.4, which is the next task and a sibling, not a dependency, of fn-72.3. SHIP overridden on factual scope grounds; no other valid concerns remained after iterative fixes (status exit-3, --json gating, silent --stop, port deferral, JSON envelope hygiene).

## Evidence

- Commits: bfffd083, 9aac5106, 154d7079, c3fc4a08, ebbbfa1c, 79b40462
- Tests: bun test test/cli/serve-flags.test.ts, bun test, bun run lint:check, manual: bun src/index.ts serve --port 3459 --detach --pid-file /tmp/x --log-file /tmp/y (parent exits in ~30ms with node-llama-cpp reachable), manual: bun src/index.ts serve --status --json (exit 3, schema-clean stdout), manual: bun src/index.ts serve --stop (exit 3 silently, no stderr)
- PRs:
