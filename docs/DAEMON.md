---
title: Daemon Mode
description: Run GNO as a headless watcher process for continuous local indexing without the web UI or desktop shell.
keywords: gno daemon, continuous indexing, local watcher, headless indexing, background knowledge index
---

# Daemon Mode

Run GNO as a headless long-running watcher process.

## What It Does

`gno daemon` keeps the same watch/sync/embed loop alive without starting the Web
UI. The same resident process also hosts stateful Streamable HTTP MCP at
`/mcp` plus the redacted `/api/resident/status` lifecycle surface. Full
`/api/status`, which includes local index and configuration details, is
available only when the daemon binds to loopback.

It also owns saved Context Capsule reverification. Register a Capsule with
`gno context watch <file>`; after filesystem sync and embedding work settles,
the daemon coalesces raw document-journal changes and reverifies affected
evidence in one bounded serial batch. A durable journal high-water mark avoids
duplicate work across restarts. If retention has expired that cursor, the next
settled cycle conservatively checks all saved registrations.

Registrations persist metadata and evidence hashes only—never Capsule bytes,
passage text, questions in notifications, or generated answers. `--notify`
emits a metadata-only local `capsule-reverified` event after the verification
record commits.

Each registration belongs to the index database named by its Capsule. Saved
files remain caller-owned and byte-for-byte unchanged on success, missing-file,
invalid-file, or exact-hash-change outcomes. A completed operation stores the
canonical `context verify` receipt; a failed operation stores only its disjoint
error record. Neither path invokes verified Ask or any generation model.

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

That skips the initial collection scan and starts the watcher immediately. Files
already on disk are not enumerated at startup, so anything untouched stays
unindexed until the next `gno update` or a restart without the flag. A
pre-existing file is still picked up if it is changed later, or if a later
ambiguous event reconciles the directory holding it — reconciliation enumerates
every eligible direct child of that directory, including files that predate
startup.

"Reacts to future file changes" includes changes the operating system does not
report cleanly. An event that cannot name an eligible file — an atomic save
reported only under its temporary sibling, or a recursive directory delete
reported only as the directory — reconciles that one directory: the eligible
files directly on disk in it are unioned with the active indexed documents
directly in it, and the result is synced. Atomic saves and deletions are picked
up live; the collection's `pattern`, `include`, `exclude`, and dotfile and
reserved-path rules are re-applied, so an ineligible file is never indexed just
because its event triggered reconciliation.

Deleting a directory deactivates every indexed document beneath it, at any
depth, whichever way the runtime reports the deletion (as the directory, as one
arbitrary child of it, or as both): a reported path that no longer exists on
disk is treated as one sample of a larger removal, and the watcher reconciles
the whole removed subtree. That holds for the collection root as well — delete
or unmount a watched collection directory and everything indexed under it
deactivates. A root that cannot be read (permission error, hung mount) is not
the same thing as a root that is gone, and deactivates nothing.

Three changes still fall outside what the watcher can observe and need a
`gno update` or a restart:

- on Linux, subdirectories created after the watcher started, on Bun versions
  whose recursive watch does not extend to them
  ([oven-sh/bun#15939](https://github.com/oven-sh/bun/issues/15939)). Measured
  on Bun 1.3.11 no event is emitted for writes inside them at all, so there is
  nothing to reconcile; on Bun 1.3.14 those writes were reported and are picked
  up live;
- on Linux, writes into a pre-existing directory that was renamed after the
  watcher started (measured on Bun 1.3.14). They are reported under the stale
  pre-rename path, so the watcher deactivates what is gone from the old path
  but never learns the new one, and the files at their new location stay
  unindexed;
- a file or directory deleted and recreated inside the same ~300 ms debounce
  window. The watcher decides whether an event was a removal by checking the
  disk once, when the batch flushes; if the path is back by then, the event
  reads as an ordinary edit. Anything else removed in that window and never
  named by its own event stays active until the next event touching its area.

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

For a live daemon, JSON status best-effort includes the same redacted resident
snapshot available at `GET /api/resident/status`; no paths, tokens, queries,
document content, or caller identities enter that nested lifecycle object.
For a non-loopback listener, the HTTP status route additionally requires the
same exact Host/Origin checks and bearer authentication as `/mcp`, plus a
compatible effective policy for every participating collection. Either control
can deny access; neither overrides the other.

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

- `gno serve`: browser or desktop session, full local REST API, dashboard,
  `/mcp`, and live indexing
- `gno daemon`: headless continuous indexing, `/mcp`, and redacted lifecycle
  status only

Only one resident owner may use a data directory. Starting the other mode
against the same `GNO_DATA_DIR` fails with the current owner hint; stop the
owner before switching modes.

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

The second process fails closed because serve and daemon are mutually exclusive
resident modes for one data directory.

Use:

- `gno serve` for browser/desktop sessions
- `gno daemon` for headless continuous indexing

Stop the running owner before switching:

```bash
gno serve --stop
gno daemon --detach
```

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
