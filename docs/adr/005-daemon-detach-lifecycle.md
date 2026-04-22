# ADR-005: Daemon and Serve Detach Lifecycle

**Status**: accepted
**Date**: 2026-04-21
**Author**: Gordon Mickel

## Context

`gno serve` and `gno daemon` are both long-running processes. Before this
work users had to reach for `nohup`, `&`, `tmux`, launchd, or systemd to
keep them alive across terminal sessions, and there was no first-party
way to ask "is it running?" or "stop it cleanly".

Epic fn-72 added a symmetric `--detach` / `--status` / `--stop` /
`--pid-file` / `--log-file` contract to both commands, backed by a JSON
pid-file under `resolveDirs().data`. A handful of design decisions taken
during implementation deviate from the original epic sketch enough to be
worth recording explicitly so future contributors don't unwind them.

## Decision

### Storage

- **Pid/log files live under `resolveDirs().data`**, not `~/.gno/`. The
  `~/.gno/` convention documented elsewhere in the repo predates the
  `resolveDirs()` helper; the helper honours `GNO_DATA_DIR`, plays nicely
  with XDG, and is what every other piece of GNO state already uses.
- **Pid-file is JSON `{pid, port?, cmd, version, started_at}`** with
  strict validation (positive-integer pid, `cmd ∈ {serve, daemon}`,
  non-empty version string), not a bare integer. The extra fields let
  `--status` and `--stop` distinguish "our crashed process" from
  "unrelated PID reuse" and refuse to signal a foreign-version live
  process. A bare PID would force us to either trust the OS blindly or
  do platform-specific process-name lookups.

### New exit code

- **Exit code `3` (`NOT_RUNNING`)** is reserved for `--status` and
  `--stop` reporting "no live matching process". It's distinct from
  `1` (validation) and `2` (runtime) so shell pipelines can branch on
  `$?` without parsing stderr.
- **`--status` exits `3` even when `running:false` payload is on
  stdout.** "Did the call succeed?" (yes, here is the state) is
  separate from "is the process running?" (no, exit 3). Scripts can
  consume the JSON and the exit code independently.
- **`--stop` is silent on `3`.** No stderr envelope when there's
  nothing to stop. Stop is idempotent in spirit; retry loops shouldn't
  have to grep stderr.

### Platform

- **Windows has no native `--detach`.** `spawnDetached` throws a clean
  `VALIDATION` error pointing at WSL. We considered a `taskkill`-based
  fallback (fn-72.6 was originally scoped for it) but Bun's Windows
  detach has documented quirks, the platform asymmetry would leak into
  every test, and WSL covers the use case for anyone on Windows who
  actually wants daemon-style backgrounding. fn-72.6 is blocked with
  this rationale; `--status` / `--stop` / `--pid-file` / `--log-file`
  stay parseable on Windows but have nothing to manage in the absence
  of a detached child.

### Spawn mechanics

- **`DETACHED_CHILD_FLAG = "--__detached-child"`** is a sentinel exported
  from `src/cli/detach.ts` and hidden from `--help`. The detached child
  re-execs `process.execPath` with the original argv plus the sentinel,
  which lets the same command body run on the second pass minus the
  detach branch. Hiding it from `--help` keeps the user-facing surface
  clean; users who pass it explicitly will at worst spawn a misbehaving
  child, and the shape of `--__` makes the intent obvious to anyone
  reading argv.
- **`stripDetachFlag` removes only the literal `--detach`.** No short
  forms, no `--detach=value`. The only registered Commander option is
  the long form, so anything else would be over-engineering.
- **Detached-child argv is sourced from `Command.rawArgs` via
  `resolveCliArgv(cmd)`**, not `process.argv.slice(2)`. The original
  implementation read the process-global `process.argv`, which meant
  programmatic callers — `runCli(["node", "gno", "daemon", "--detach",
...])` from tests or embedded callers — would re-exec the host
  process's argv (e.g. `bun test ...`) instead of the requested
  invocation. `resolveCliArgv` walks up to the root Commander Command
  and reads `rawArgs.slice(2)`, which is per-`parseAsync()` state.
  Back-to-back `runCli([...])` invocations in the same process can no
  longer taint each other's child argv. Regression tests live in
  `test/cli/detach-argv.test.ts`.

### Race-safety

- **Sidecar `.startlock` via `O_CREAT|O_EXCL`**, not a lock embedded in
  the pid-file. Two parents racing to claim the slot collide on the
  lock file before either writes the pid-file, so a partial pid-file is
  never observable. Embedding the lock in the pid-file would require
  either advisory `flock` (platform-variable) or a write-then-read
  protocol that's still racy.
- **The detached child runs a bounded `verifyPidFileMatchesSelf` poll**
  on first tick rather than the simpler "assert on first tick" sketched
  in the epic. The parent writes the pid-file _after_ spawn returns;
  the child can boot before the write completes. A short bounded poll
  closes the window without permanently waiting for a parent that
  crashed mid-spawn.

### Lifecycle teardown

- **`stopProcess` returns a `StopOutcome` discriminated union**:
  `not-running` | `stopped(SIGTERM|SIGKILL)` | `timeout` | `foreign-live`.
  The alternative — throwing on every non-success path — would force
  callers to translate exceptions into exit codes inline, and would
  hide the `foreign-live` case behind a generic `Error`. The
  discriminated union also keeps unit tests honest about which branches
  exist.
- **`installPidFileCleanup` uses sync `unlinkSync` on
  SIGINT/SIGTERM/beforeExit.** The serve runtime doesn't already own a
  signal-handling primitive in the same shape as daemon's
  `createSignalPromise`; a one-shot sync handler is the smallest change
  that survives crashes during subsequent async teardown.
- **Daemon stacks both.** Its existing `createSignalPromise` (in
  `src/cli/commands/daemon.ts:34-64`) handles the orderly shutdown
  message; `installPidFileCleanup` is layered on top in `program.ts`
  (in `handleDaemonAction`'s detached-child branch) for the sync
  unlink. Documenting the stacking explicitly so a future refactor
  doesn't collapse them: the orderly path emits the shutdown banner,
  the sync path guarantees the pid-file disappears even if the orderly
  path crashes.

### Output gating

- **`--json` is gated to `--status` only.** `--detach` and `--stop`
  reject `--json` with a hard `VALIDATION` error rather than silently
  no-op'ing it. Hard fail prevents users from thinking they'll get
  structured output on `--detach` (which exits before any structured
  result exists) or `--stop` (which has only an exit code to convey),
  and keeps the format-matrix in `spec/cli.md` honest.
- **Foreign-live metadata rides on `CliError.details`**, not a parallel
  stderr write. Keeps JSON-mode stderr a single parseable envelope.
  Operators inspecting the envelope get `code: NOT_RUNNING` plus
  structured `details.foreign_live` (`{pid, recorded_version,
current_version}`) and can decide whether to terminate the foreign
  pid manually.

## Consequences

### Positive

- One contract for both commands; users learn it once.
- `nohup` examples removed from in-repo docs (`docs/`, `README.md`,
  `assets/skill/`). The matching `~/work/gno.sh` website edits land in
  the paired gno.sh PR for fn-72.8.
- Pipelines can branch on `$?` instead of grep-on-stderr.
- Pid-file collisions (PID reuse, foreign upgrade) are surfaced rather
  than silently mishandled.
- Programmatic CLI callers (tests, embeds) can detach without taint.

### Negative

- Two cleanup primitives on daemon (`createSignalPromise` +
  `installPidFileCleanup`) instead of one. Documented above.
- Windows users wanting native backgrounding must use WSL or an
  external supervisor. We accept this asymmetry.
- One more exit code (`3`) for callers to handle. Mitigated by it being
  scoped to two commands.

## Notes

- Per-index naming (`{data}/serve-<index>.pid`) is an explicit non-goal
  for v1: one serve, one daemon per `GNO_DATA_DIR`.
- The shared user-facing contract lives at
  [`docs/CLI.md#long-running-processes`](../CLI.md#long-running-processes).
  Skill reference at `assets/skill/cli-reference.md` mirrors it.
