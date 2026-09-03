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

The shared resident watcher treats exact and ambiguous notifications
differently. A contained eligible file path always reaches content hashing,
including same-size edits whose mtime was restored. Atomic-save temp names,
missing filenames, directories, vanished paths, and recursive deletion events
trigger bounded reconciliation against filesystem and active-index evidence.
Only proven candidates are resubmitted and only proven removals are
inactivated, so untouched siblings are preserved. Failed scans, queries, edge
projection, or file sync retain durable retry authority; bounded overflow or a
platform without native anchored directory handles escalates to a full
collection sync.

These guarantees are exercised on supported local filesystems across macOS,
Linux, and Windows. They do not claim universal watcher semantics for network,
removable, or coarse-timestamp filesystems.

When a collection sets `sourceAvailability: local`, scheduled indexing and
watch-triggered ingestion use the same source-availability boundary as
foreground `gno index` / `gno update`: hierarchical directory classification,
guarded content rechecks, cloud-placeholder skips, and preservation of indexed
descendants under unproven prefixes. Default `any` is unchanged. Source
availability is distinct from `egressPolicy`. Support is evidence-qualified for
tested macOS File Provider configurations only (Google Drive, iCloud Drive, and
OneDrive for both validated immediate SharePoint library roots); unsupported
platforms/filesystems fail closed under `local`.

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

That starts the watcher immediately and only reacts to future file changes.
It does not weaken reconciliation for those future changes or change the
status, Capsule-settlement, REST, or MCP contracts.

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

When the scheduled findings pass is enabled, `--status` also prints a
`findings` line (see [Scheduled Findings Pass](#scheduled-findings-pass)).

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

## Scheduled Findings Pass

Opt-in. The daemon can run the read-only knowledge-integrity audit
(`gno audit`, all categories) on a fixed cadence and write each finding as an
ordinary Markdown record into a collection you configure. Records are
queryable through normal retrieval (`gno search ... --collection findings`,
`--tag finding`), inherit that collection's egress policy, and are deleted
like any other file. The pass is report-only: it never repairs a link, edits
a source, or touches config.

```yaml
# index.yml
findings:
  enabled: true # default false
  cadence: 6h # <n>s|m|h|d, 10s..30d (default 6h)
  collection: findings # must already exist in `collections`
```

Setup and contract:

- The findings collection is created by you (`gno collection add ~/notes/findings --name findings`).
  Enabling with `collection` unset, naming a collection that does not exist, or an
  invalid cadence fails `gno daemon` startup with a clear message; the daemon never
  creates collections or writes outside the configured collection path.
- The findings collection itself is excluded from the audit scope, so records never
  audit each other.
- Record identity is the audit finding id: a hash of the check (rule), the target
  URI/location, and the evidence fingerprint. File name `finding-<id24>.md`,
  full id in frontmatter. A repeat run with the same finding is a byte-identical
  no-op; a finding that disappears is flipped to `status: resolved` (with
  `resolvedAt`) on the next complete run, and reopened if it returns. Absence is
  only trusted when the report is complete, untruncated, and the record's rule
  actually ran.
- Retention is bounded: resolved records older than 30 days are deleted, and the
  collection never holds more than 2000 records (oldest resolved go first).
  Only files whose frontmatter marks them as daemon-written records are ever
  rewritten or deleted.
- The audit itself runs without the write lease, so a long audit never blocks
  capture or CLI writers. Only the record write takes the shared
  `.mcp-write.lock` lease, with no wait. If a writer (`gno index`, `gno embed`,
  an MCP write job) holds it at that moment, the write is skipped and the run
  is recorded as `skipped_lease`; it does not queue behind long embeds.
- Silent when clean: a run with nothing new writes no files and logs nothing.
  New, reopened, resolved, or expired records produce one log line; a failed run
  logs an error; a lease skip logs only with `--verbose`.
- Cadence is a floor: a pass still running when the next tick fires defers the
  tick until it finishes.

Observability (no debug logs needed): every attempt persists its outcome to
`{data}/index-<name>.findings-run.json`. `gno daemon --status` prints a
`findings` line and `--status --json` carries a `findings` object with
`state` (`pending` | `success` | `failed` | `skipped_lease` | `overdue`),
`lastRunAt`, `lastSuccessAt`, `nextDueAt`, `durationMs`, `counts`
(`findings`, `written`, `reopened`, `resolved`, `deleted`, `open`) and `error`.
`overdue` is derived at read time once `nextDueAt` has slipped by a full
cadence, so a stopped or starved daemon is distinguishable from a clean one.
`gno doctor` reports the same state as the `findings-pass` check (`warn` on
`skipped_lease` / `overdue` / no recorded run, `error` on `failed` or a
misconfigured block). A state file that cannot be written (permissions, disk
full) does not stop the loop: the attempt is logged as a failed pass with the
write error, and a corrupt or hand-edited state file (for example a non-numeric
count) reads as no recorded run rather than a partial status. Starting the
daemon with findings disabled removes a stale state file.

Saved Context Capsule reverification is explicitly **not** part of this pass.
Its scheduler is journal-driven (it runs after sync settles, see above); calling
it on a cadence would be a no-op between changes, so it stays as-is.

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
