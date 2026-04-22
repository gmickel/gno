---
title: Daemon Mode
description: Run GNO as a headless watcher process for continuous local indexing without the web UI or desktop shell.
keywords: gno daemon, continuous indexing, local watcher, headless indexing, background knowledge index
---

# Daemon Mode

Run GNO as a headless long-running watcher process.

## What It Does

`gno daemon` keeps the same watch/sync/embed loop alive without starting the Web
UI server.

Use it when:

- you want continuous indexing from the terminal
- local agent workflows need a fresh index
- you do not need the browser or desktop shell open

## Start

In the foreground:

```bash
gno daemon
```

Stop with `Ctrl+C`.

Detached (background, macOS/Linux only):

```bash
gno daemon --detach
```

The parent prints `PID <pid>` and exits 0; the child writes to
`{data}/daemon.log` (where `{data}` is `resolveDirs().data`, configurable via
`GNO_DATA_DIR`). Override with `--log-file <path>`.

## Skip Initial Sync

```bash
gno daemon --no-sync-on-start
```

That starts the watcher immediately and only reacts to future file changes.

## Managing the Daemon

`gno daemon` ships with built-in lifecycle controls. The contract mirrors
`gno serve` exactly.

| Flag                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `--detach`          | Self-spawn a detached child; parent prints `pid` and exits 0              |
| `--status`          | Read pid-file, check liveness, print status (`--json` for machine output) |
| `--stop`            | SIGTERM with 10s timeout, SIGKILL fallback                                |
| `--pid-file <path>` | Override pid-file location (defaults to `{data}/daemon.pid`)              |
| `--log-file <path>` | Override log-file location (append-only)                                  |

`--detach`, `--status`, and `--stop` are mutually exclusive.

```bash
# Start detached
gno daemon --detach

# Check status (terminal)
gno daemon --status

# Check status (machine-readable; exits 3 when not running)
gno daemon --status --json

# Stop gracefully (SIGTERM with 10s timeout, then SIGKILL fallback)
gno daemon --stop

# Override paths
gno daemon --detach --pid-file /tmp/gd.pid --log-file /tmp/gd.log
```

### Exit Codes

- `0` — `--detach` succeeded, `--stop` completed, or `--status` found a live process
- `1` (`VALIDATION`) — mutex violation, bad flag combination, Windows `--detach`, or `--json` paired with anything other than `--status`
- `2` (`RUNTIME`) — runtime failure (IO/DB/model)
- `3` (`NOT_RUNNING`) — `--status` or `--stop` found no live matching process

`--status` always emits the schema-shaped payload on stdout, even when it exits 3. `--stop` is silent when there is nothing to stop — script against the exit
code, not stderr text.

### `--json` Gating

`--json` is only defined for `--status`. Combining it with `--detach`, `--stop`,
or the foreground path returns a `VALIDATION` error:

```
--json is only supported with `gno daemon --status`
```

### Live-Foreign Pids

If you upgrade gno while a detached daemon is still running, the new binary
treats the live process as foreign and refuses to manage it. `--stop` errors
with a `VALIDATION` exit telling you to terminate it manually:

```
gno daemon (pid 12345) is live but was started by gno 1.0.4; this binary is 1.1.0.
Refusing to signal pid 12345; terminate it manually and delete /path/to/daemon.pid.
```

`--status --json` reports `running:false` and emits a `NOT_RUNNING` envelope on
stderr with `details.foreign_live = { pid, recorded_version, current_version }`.

## When To Use `daemon` vs `serve`

- `gno serve`: browser or desktop session, API, dashboard, live indexing
- `gno daemon`: headless continuous indexing only

Avoid running both against the same index at the same time until explicit
cross-process coordination exists.

## Typical Flow

```bash
gno init ~/notes --name notes
gno index
gno daemon --detach
gno daemon --status
```

Then keep using normal CLI commands in another terminal:

```bash
gno search "meeting notes"
gno ask "what changed this week" --answer
gno ls
```

When you're done:

```bash
gno daemon --stop
```

## Offline / Manual Model Policy

Use global flags and env vars exactly like the rest of GNO:

```bash
gno daemon --offline
GNO_NO_AUTO_DOWNLOAD=1 gno daemon
```

- `--offline` uses cached models only
- `GNO_NO_AUTO_DOWNLOAD=1` disables automatic download while still allowing
  explicit `gno models pull`

## Windows

Native `--detach` is **not supported** on Windows. The flag returns a clean
`VALIDATION` error pointing you at WSL. `--status` / `--stop` / `--pid-file` /
`--log-file` remain parseable but have nothing to manage without a detached
child.

For Windows-native long-running deployment, run `gno daemon` under WSL or wrap
the foreground process with a service supervisor (NSSM, sc.exe).

## Troubleshooting

### "Nothing updated"

Check:

- the daemon is still running (`gno daemon --status`)
- the changed file matches your collection pattern/include/exclude rules
- you did not start it with `--no-sync-on-start` and then expect old files to
  be imported retroactively

### "I changed config but nothing happened"

Restart the daemon. v1 reads config on startup.

```bash
gno daemon --stop
gno daemon --detach
```

### "I also ran gno serve"

Do not run both against the same index at the same time.

Use:

- `gno serve` for browser/desktop sessions
- `gno daemon` for headless continuous indexing

### "pid-file exists but `--status` says not running"

The recorded pid is dead. `--status` reports stale pid-files as
`running:false` (exit 3); the next `--detach` cleans the stale pid-file
automatically before spawning the new child.

### "another serve/daemon start is in progress"

Two parallel `--detach` invocations race for the same pid-file. Detach takes
out an atomic start-lock (a `.startlock` sidecar next to the pid-file) for the
duration of the spawn. If you see:

```
another gno daemon start is in progress (lock-file /path/to/daemon.pid.startlock)
```

…another `--detach` is mid-flight. Stale locks (>30s old) auto-recover; if you
need to clear a fresh stuck lock, delete the `.startlock` sidecar manually.

### "live-foreign pid: refusing to signal"

You upgraded gno while a detached daemon was still running. `--stop` will not
SIGTERM the old process because it was started by a different binary version.

```
gno daemon (pid 12345) is live but was started by gno 1.0.4; this binary is 1.1.0.
Refusing to signal pid 12345; terminate it manually and delete /path/to/daemon.pid.
```

Resolve manually:

```bash
kill 12345
rm /path/to/daemon.pid
gno daemon --detach
```

The same metadata is exposed to JSON consumers: `gno daemon --status --json`
returns `running:false` plus a NOT_RUNNING envelope on stderr carrying
`details.foreign_live = { pid, recorded_version, current_version }`.
