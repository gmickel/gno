# Backgrounding flags for `gno serve` and `gno daemon`

## Overview

Add first-class self-backgrounding to both `gno serve` and `gno daemon` so users stop reaching for `nohup`, `&`, `tmux`, or hand-rolled launchd/systemd units. Introduce symmetric `--status` / `--stop` controls backed by a PID file with JSON metadata. Ship a single shared helper (`src/cli/detach.ts`) used by both commands so the UX is identical.

## Scope

New flags on both `gno serve` and `gno daemon`:

- `--detach` — self-spawn a detached child, print PID + URL (serve) or PID (daemon), parent exits 0.
- `--pid-file <path>` — override pid-file location.
- `--log-file <path>` — override log-file location; opened in append mode.
- `--status` — read pid-file, check liveness, print status (structured JSON when `--json`).
- `--stop` — read pid-file, SIGTERM with timeout, SIGKILL fallback, clean up pid-file.

`--detach`, `--status`, and `--stop` are mutually exclusive (Commander `.conflicts()`).

Default paths live under `resolveDirs().data` (env-configurable via `GNO_DATA_DIR`), **not** `~/.gno/`:

- `{data}/serve.pid`, `{data}/serve.log`
- `{data}/daemon.pid`, `{data}/daemon.log`

(Per-index naming is an explicit non-goal for v1 — one serve, one daemon per `GNO_DATA_DIR`.)

## Approach

**Derisk first.** fn-72.9 is a throwaway spike that proves `Bun.spawn({ detached: true, stdio: ["ignore", fd, fd] }).unref()` works in this repo's environment. **fn-72.9 did NOT validate the LLM native-thread hazard** (variant 2 ran `ask --help`, which exits before lazy LLM imports). That risk is still open and is addressed in fn-72.2 with an ad-hoc validation step and in the acceptance criteria of fn-72.3/fn-72.4. Runs in parallel with fn-72.1 (spec work).

**Single shared helper** at `src/cli/detach.ts` — both `wireServeCommand` and `wireDaemonCommand` route through it. No duplicated logic.

- Self-spawn via `Bun.spawn` with `detached: true`, `stdio: ["ignore", logFd, logFd]`, `.unref()`. Log fd opened with `node:fs.openSync(path, "a")` — a numeric fd, not a `Bun.file()` (Bun closes `Bun.file()` fds on parent exit).
- Child reinvokes `process.execPath` with a sentinel flag (e.g. `--__detached-child`) so the command body runs normally minus the detach branch.
- Pid-file is JSON: `{pid, port?, cmd, version, started_at}`. Atomic write via existing `atomicWrite()` at `src/core/file-ops.ts:14-28`.
- Liveness via `process.kill(pid, 0)`, handling `ESRCH` (dead, clean up), `EPERM` (alive but not ours, treat as live).
- PID reuse mitigation: after liveness passes, cross-check stored `cmd`/`version`; if mismatch treat as stale.
- Graceful stop: SIGTERM → poll every 100ms up to 10s → SIGKILL → poll 2s → error. Let the daemon itself unlink the pid-file in its signal handler (reuse `createSignalPromise` at `src/cli/commands/daemon.ts:34-64`); only unlink from `--stop` as a fallback when liveness says dead.
- Extend exit codes: add `NOT_RUNNING = 3` to `src/cli/errors.ts` `CliErrorCode`, update `exitCodeFor`, update `runCli` error mapping at `src/cli/run.ts:201-248`, update `spec/cli.md` exit-codes table.
- Status output supports `--json` via the new `spec/output-schemas/process-status.schema.json`; terminal output follows the style of `src/cli/commands/mcp/status.ts:144-222`.

## Platform

- **Unix (macOS + Linux):** full feature set — `setsid()` via `detached: true`, SIGTERM graceful shutdown.
- **Windows:** `--detach` is **not supported**. `spawnDetached` throws a clean `VALIDATION` error pointing Windows users to WSL (or a launcher like NSSM). `--status`/`--stop`/`--pid-file`/`--log-file` remain functional but vestigial — without a detached child nothing writes the pid-file, so `--status` always reports `NOT_RUNNING`.

**Rationale for dropping Windows native detach:** Bun's Windows detach has documented quirks, taskkill plumbing adds platform asymmetry, and WSL covers the use case for anyone on Windows who actually wants daemon-style backgrounding. fn-72.6 is blocked with this rationale.

## Reuse

- `src/core/file-ops.ts:14-28` — `atomicWrite()` for pid-file tmp+rename.
- `src/cli/commands/daemon.ts:34-64` — `createSignalPromise` signal pattern.
- `src/app/constants.ts:134-207` — `resolveDirs()` for default pid/log locations (honours `GNO_DATA_DIR`).
- `src/config/paths.ts:24-44` — `expandPath`/`toAbsolutePath` for user-supplied `--pid-file`/`--log-file`.
- `src/cli/options.ts:146-175` — shared option parsing.
- `src/cli/commands/mcp/status.ts:144-222` — reference for json/terminal status output.
- `test/cli/concurrency.test.ts:44-50` — template for CLI subprocess tests.

## Risks

- **`unref()` is required, not optional** on Bun — `detached: true` alone will not let the parent exit. Document clearly in `detach.ts`. fn-72.9 spike validated this on a heartbeat child.
- **LLM native threads holding parent open — STILL OPEN.** `src/llm/nodeLlamaCpp/lifecycle.ts` keeps threads alive. Detach must happen early in the action handler, before any port/runtime instantiation. fn-72.9 did **not** validate this (`ask --help` exits before lazy imports load). fn-72.2 carries an ad-hoc validation step; fn-72.3 and fn-72.4 must confirm real serve/daemon subcommands detach cleanly, and restructure to detach at the top-level program action if Commander-dispatch-time detachment proves insufficient.
- **Double-start race** is narrow but real. Mitigation: parent writes pid-file after spawn returns; child re-reads and asserts `pid === process.pid` on first tick, exits 1 if mismatch.
- **Stale pid-file after crash** — JSON metadata (cmd+version) lets `--status` distinguish "our crashed process" from "unrelated PID reuse".
- **Working directory inheritance** — child inherits parent cwd. Resolve all paths to absolute before spawning.
- **`spec/cli.md` format-matrix update** — serve and daemon rows currently list all format cells `no`; adding `--status --json` requires updating the matrix.
- **Shared file edits** — `spec/cli.md`, `docs/CLI.md` are touched by other in-flight epics (fn-64). Land carefully to avoid merge conflicts.
- **Existing `nohup` examples** — across `docs/` in this repo **and** on the external website at `~/work/gno.sh` (notably `src/lib/product-pages.ts:582` which currently recommends `nohup gno daemon > /tmp/gno-daemon.log 2>&1 &` as the supported pattern). Must search-and-replace comprehensively.

## Website location

The public site now lives at **`~/work/gno.sh`** (separate Vite + TanStack Router repo). The in-repo `website/` directory is legacy and not actively published — do NOT update it. Website edits ship as a separate PR in the gno.sh repo; coordinate the merge so gno.sh doesn't document flags that haven't shipped in gno yet. Post-merge deploy: `DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh`.

Key gno.sh files that mention `gno serve` or `gno daemon`:

- `src/lib/gno-docs.tsx:581-705` — CLI reference (inline JSX, not markdown).
- `src/lib/product-pages.ts:566-592` — daemon-mode feature page (has stale `nohup` example).
- `src/lib/product-pages.ts:663, 731-733` — FAQ about daemon lifecycle.
- `src/lib/gno-comparisons.tsx:92-94` — comparison row for headless daemon.

## Dependencies

- **fn-55** (headless daemon and watch mode) — foundational; landed/done. Its spec explicitly listed PID-file management and `start/stop/status` as V1 non-goals; this epic is the planned V2.

## Coordination (not blocking)

- **fn-57** (Mac/Linux packaging) — will consume the final flag surface for launchd/systemd docs.
- **fn-64** (terminal nav) — shares `spec/cli.md` + `docs/CLI.md` surface.

## Quick commands

```bash
# Smoke test after implementation
gno serve --detach
gno serve --status
gno serve --status --json
gno serve --stop

gno daemon --detach --log-file /tmp/gd.log
gno daemon --status
gno daemon --stop

# Guard against double-start
gno serve --detach
gno serve --detach  # must fail with "already running"

# Stale pid cleanup
gno serve --detach
kill -9 $(jq -r .pid "$(gno serve --status --json | jq -r .pid_file)")
gno serve --status  # must detect stale and report "not running"
gno serve --detach  # must succeed after cleanup

# Windows (not supported)
gno serve --detach  # must fail with clean error pointing to WSL

# Build gate
bun run lint:check && bun test
bun test test/cli/detach.test.ts test/cli/detach.integration.test.ts
```

## Acceptance

- [ ] Spike (fn-72.9) validates Bun detach + unref + stdio fd on macOS with a trivial heartbeat child. LLM-thread hazard remains open; fn-72.2/.3/.4 acceptance confirms real serve/daemon subcommands detach cleanly with `node-llama-cpp` in the module graph.
- [ ] `gno serve --detach` and `gno daemon --detach` spawn a detached child on macOS/Linux; parent exits 0 with PID printed.
- [ ] `--pid-file <path>` and `--log-file <path>` override defaults; user-supplied `~`-paths expand.
- [ ] `--status` prints pid/uptime/port and supports `--json` matching the new schema.
- [ ] `--stop` graceful via SIGTERM with 10s timeout → SIGKILL fallback; exits 0 when done, 3 (`NOT_RUNNING`) when no process.
- [ ] `--detach`, `--status`, `--stop` are mutually exclusive (Commander conflicts; clear error message).
- [ ] Double-start blocked; stale pid-file auto-cleaned.
- [ ] Exit code 3 (`NOT_RUNNING`) added to `src/cli/errors.ts` and `spec/cli.md`.
- [ ] Windows `--detach` returns a clean `VALIDATION` error referencing WSL; integration test covers it.
- [ ] New `spec/output-schemas/process-status.schema.json` + contract test.
- [ ] `docs/CLI.md`, `docs/DAEMON.md`, `docs/WEB-UI.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md`, `README.md`, `CHANGELOG.md` all updated — no stale `nohup` examples remain in this repo.
- [ ] External website `~/work/gno.sh` updated (CLI reference in `gno-docs.tsx`; daemon-mode feature page + FAQ in `product-pages.ts`; stale `nohup` examples replaced). Separate PR in that repo. Deployed via `DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh`.
- [ ] `assets/skill/cli-reference.md` updated; ClawHub skill version bump noted in release notes.
- [ ] ADR `docs/adr/005-daemon-detach-lifecycle.md` filed.
- [ ] `bun run lint:check && bun test` green in this repo; `bun run dev` in `~/work/gno.sh` renders the updated pages.

## Early proof point

Task fn-72.9 (spike) validates Bun detach + unref + stdio fd in this repo's environment on a trivial heartbeat child. The LLM native-thread hazard was **not** retired by the spike (variant 2 ran `ask --help`, which exits before lazy LLM imports load). fn-72.2 carries an ad-hoc validation step, and fn-72.3/fn-72.4 must confirm the real serve/daemon subcommands detach cleanly with `node-llama-cpp` reachable. If they don't, restructure `detach.ts` / top-level program action to detach earlier, or re-evaluate whether to ship this feature and instead document launchd/systemd as the recommended path.

## Requirement coverage

| Req | Description                                                                                    | Task(s)                            | Gap justification                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| R0  | Derisking spike — validate Bun detach mechanics (LLM-thread hazard deferred to fn-72.2/.3/.4)  | fn-72.9, fn-72.2, fn-72.3, fn-72.4 | Spike only covered Bun detach+unref+stdio; LLM-thread validation lands with real subcommand wiring |
| R1  | Spec + schemas + exit-code table updated before implementation                                 | fn-72.1                            | —                                                                                                  |
| R2  | Shared `src/cli/detach.ts` helper (spawn, pid-file, liveness, stop, status)                    | fn-72.2                            | —                                                                                                  |
| R3  | New `NOT_RUNNING` exit code (3) in error model + spec                                          | fn-72.2                            | —                                                                                                  |
| R4  | `gno serve` wiring with all five flags + mutex                                                 | fn-72.3                            | —                                                                                                  |
| R5  | `gno daemon` wiring with all five flags + mutex                                                | fn-72.4                            | —                                                                                                  |
| R6  | Integration tests: spawn, status, stop, stale cleanup, double-start guard, Windows clean error | fn-72.5                            | —                                                                                                  |
| R7  | Windows `--detach` clean error + WSL guidance (no native Windows backgrounding)                | fn-72.2, fn-72.5                   | fn-72.6 blocked; native Windows detach out of scope                                                |
| R8  | In-repo `docs/` + README + CHANGELOG updates                                                   | fn-72.7                            | —                                                                                                  |
| R9  | External website (`~/work/gno.sh`) + skill reference + ADR + production deploy                 | fn-72.8                            | —                                                                                                  |
