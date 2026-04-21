# fn-72-backgrounding-flags-for-serve-and-daemon.2 Shared src/cli/detach.ts helper + NOT_RUNNING exit code

## Description

Build the shared helper that both `gno serve` and `gno daemon` will call through, plus extend the exit-code model. Incorporate findings from the fn-72.9 spike.

**Size:** M
**Files:**

- `src/cli/detach.ts` (new)
- `src/cli/errors.ts` (extend `CliErrorCode` + `exitCodeFor`)
- `src/cli/run.ts` (extend error-to-exit mapping around L201-248)
- `test/cli/detach.test.ts` (new — unit tests with sandboxed `GNO_DATA_DIR`)

## Approach

- `resolveProcessPaths(kind: "serve" | "daemon", overrides?: { pidFile?: string; logFile?: string })` → `{ pidFile, logFile }`. Defaults from `resolveDirs().data` (honours `GNO_DATA_DIR`); user overrides pass through `expandPath` from `src/config/paths.ts:24-44`.
- `spawnDetached({ kind, argv, logFile, pidFile, env })`:
  - **Windows gate:** if `process.platform === "win32"` throw `CliError("VALIDATION", "`--detach` is not supported on Windows. Use WSL, or a Windows launcher like NSSM. See docs/WINDOWS.md.")`.
  - Open log fd via `node:fs.openSync(logFile, "a")` — numeric fd, **not** `Bun.file()` (Bun closes file objects on parent exit).
  - `Bun.spawn({ cmd: [process.execPath, ...argv, "--__detached-child"], detached: true, stdio: ["ignore", fd, fd], env })`
  - Call `.unref()` on the child (Bun-specific: without this the parent won't exit even with `detached: true`).
  - Call `fs.closeSync(fd)` in the parent after spawn — the child has its own dup of the fd at spawn time, so closing the parent's copy does not affect the child's stdout/stderr. <!-- Updated by plan-sync: fn-72.9 confirmed this detail -->
  - Parent writes pid-file JSON via `atomicWrite` from `src/core/file-ops.ts:14-28`. Payload: `{pid, cmd, version, started_at, port?}`.
- `readPidFile(path)` → parse JSON, validate shape.
- `isProcessAlive(pid)` → `process.kill(pid, 0)`; handle `ESRCH` (dead), `EPERM` (alive but another user — treat as alive, exit with guidance), generic errors.
- `stopProcess({ pidFile, timeoutMs = 10000 })` — SIGTERM → poll `isProcessAlive` every 100ms until timeout → SIGKILL → poll 2s more → error. Do NOT unlink pid-file from here unless liveness confirmed dead (let the daemon's own signal handler do the cleanup via the existing `createSignalPromise` pattern at `src/cli/commands/daemon.ts:34-64`).
- `statusProcess({ pidFile })` → `{ running, pid, port?, cmd, version, started_at, uptime_seconds, pid_file, log_file, log_size_bytes }` matching the schema from fn-72.1. Safe to call on Windows — just reports `NOT_RUNNING` since no pid-file will exist.
- `guardDoubleStart(pidFile)` → if live + JSON cmd matches → throw `CliError("VALIDATION", "already running on port X (pid Y)")`; if stale → unlink and return.

**Extend error model:**

- Add `NOT_RUNNING` to `CliErrorCode` union in `src/cli/errors.ts`.
- Update `exitCodeFor` to map `NOT_RUNNING → 3`.
- Update `runCli` error handling at `src/cli/run.ts:201-248`.

**Spike findings (fn-72.9) — applied:** <!-- Updated by plan-sync: spike proved no LLM-thread hazard -->

- Parent exits in ~17ms on macOS (Bun 1.3.5) with `detached: true` + numeric-fd stdio + `.unref()` — well under 1s budget.
- **No LLM-thread hang.** The gno CLI's module graph has no import side-effects that keep the detached parent alive; LLM native threads only start inside the child when the command body runs. Detach can happen inside the action handler as the first await, before any port/runtime instantiation — no restructuring of `wireServeCommand`/`wireDaemonCommand` required.
- Child confirmed `process.kill(parentPid, 0)` returns `ESRCH` ~2s after parent exit — detachment is real.

## Investigation targets

**Required:**

- fn-72.9 done summary (spike findings)
- `src/core/file-ops.ts:14-28` — `atomicWrite` (reuse for pid-file)
- `src/cli/errors.ts:12-36` — `CliErrorCode`/`exitCodeFor`
- `src/app/constants.ts:134-207` — `resolveDirs` (default paths)
- `src/config/paths.ts:24-44` — `expandPath`/`toAbsolutePath`
- `src/cli/commands/daemon.ts:34-64` — `createSignalPromise` signal pattern

**Optional:**

- `src/core/file-lock.ts:106-112` — prior `Bun.spawn` reference usage in the repo
- `test/cli/concurrency.test.ts:44-50` — CLI subprocess test template
- `test/helpers/cleanup.ts` — `safeRm`/temp-dir helpers

## Key context

- **Bun gotcha:** `detached: true` alone won't let the parent exit. `.unref()` is required, not optional.
- **Bun gotcha:** pass a numeric fd for stdio redirection to a file; `Bun.file()` objects get closed on parent exit.
- **Windows:** only `--detach` is gated; `--status`, `--stop`, `--pid-file`, `--log-file` all work (just vestigial since no pid-file will exist without detach).
- PID reuse mitigation: after `kill(pid, 0)` success, cross-check stored `cmd`/`version` fields.

## Approach

- `resolveProcessPaths(kind: "serve" | "daemon", overrides?: { pidFile?: string; logFile?: string })` → `{ pidFile, logFile }`. Defaults from `resolveDirs().data` (honours `GNO_DATA_DIR`); user overrides pass through `expandPath` from `src/config/paths.ts:24-44`.
- `spawnDetached({ kind, argv, logFile, pidFile, env })`:
  - Open log fd via `node:fs.openSync(logFile, "a")` — numeric fd, **not** `Bun.file()` (Bun closes file objects on parent exit).
  - `Bun.spawn({ cmd: [process.execPath, ...argv, "--__detached-child"], detached: true, stdio: ["ignore", fd, fd], env })`
  - Call `.unref()` on the child (Bun-specific: without this the parent won't exit even with `detached: true`).
  - Parent writes pid-file JSON via `atomicWrite` from `src/core/file-ops.ts:14-28`. Payload: `{pid, cmd, version, started_at, port?}`.
- `readPidFile(path)` → parse JSON, validate shape.
- `isProcessAlive(pid)` → `process.kill(pid, 0)`; handle `ESRCH` (dead), `EPERM` (alive but another user — treat as alive, exit with guidance), generic errors.
- `stopProcess({ pidFile, timeoutMs = 10000 })` — SIGTERM → poll `isProcessAlive` every 100ms until timeout → SIGKILL → poll 2s more → error. Do NOT unlink pid-file from here unless liveness confirmed dead (let the daemon's own signal handler do the cleanup via the existing `createSignalPromise` pattern at `src/cli/commands/daemon.ts:34-64`).
- `statusProcess({ pidFile })` → `{ running, pid, port?, cmd, version, started_at, uptime_seconds, pid_file, log_file, log_size_bytes }` matching the schema from fn-72.1.
- `guardDoubleStart(pidFile)` → if live + JSON cmd matches → throw `CliError("VALIDATION", "already running on port X (pid Y)")`; if stale → unlink and return.

**Extend error model:**

- Add `NOT_RUNNING` to `CliErrorCode` union in `src/cli/errors.ts`.
- Update `exitCodeFor` to map `NOT_RUNNING → 3`.
- Update `runCli` error handling at `src/cli/run.ts:201-248`.

## Investigation targets

**Required:**

- `src/core/file-ops.ts:14-28` — `atomicWrite` (reuse for pid-file)
- `src/cli/errors.ts:12-36` — `CliErrorCode`/`exitCodeFor`
- `src/app/constants.ts:134-207` — `resolveDirs` (default paths)
- `src/config/paths.ts:24-44` — `expandPath`/`toAbsolutePath`
- `src/cli/commands/daemon.ts:34-64` — `createSignalPromise` signal pattern

**Optional:**

- `src/core/file-lock.ts:106-112` — prior `Bun.spawn` reference usage in the repo
- `test/cli/concurrency.test.ts:44-50` — CLI subprocess test template
- `test/helpers/cleanup.ts` — `safeRm`/temp-dir helpers

## Key context

- **Bun gotcha:** `detached: true` alone won't let the parent exit. `.unref()` is required, not optional.
- **Bun gotcha:** pass a numeric fd for stdio redirection to a file; `Bun.file()` objects get closed on parent exit.
- PID reuse mitigation: after `kill(pid, 0)` success, cross-check stored `cmd`/`version` fields.
- Detach can happen as the first await in the action handler — the fn-72.9 spike confirmed no LLM-thread hazard in the CLI module graph, so no restructuring of `wireServeCommand`/`wireDaemonCommand` is required before spawning. <!-- Updated by plan-sync: fn-72.9 disproved the LLM-thread hang hypothesis -->

## Acceptance

- [ ] `src/cli/detach.ts` exports `resolveProcessPaths`, `spawnDetached`, `readPidFile`, `isProcessAlive`, `stopProcess`, `statusProcess`, `guardDoubleStart`
- [ ] `spawnDetached` throws clean `VALIDATION` error on Windows pointing users to WSL
- [ ] `NOT_RUNNING` exit code (3) wired in `src/cli/errors.ts` + `src/cli/run.ts`
- [ ] Unit tests cover: default path resolution, `expandPath` user overrides, atomic pid-file write+read, stale detection via `ESRCH`, JSON payload shape round-trip, Windows-platform error message
- [ ] Tests use `GNO_DATA_DIR` env var to sandbox (no writes to `~/.local/share/gno`)
- [ ] Spike findings from fn-72.9 applied (or documented as N/A if spike was clean)
- [ ] `bun run lint:check && bun test test/cli/detach.test.ts` green

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
