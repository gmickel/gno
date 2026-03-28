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

```bash
gno daemon
```

Foreground-only in v0.30. Stop with `Ctrl+C`.

If you want it supervised:

```bash
nohup gno daemon > /tmp/gno-daemon.log 2>&1 &
```

## Skip Initial Sync

```bash
gno daemon --no-sync-on-start
```

That starts the watcher immediately and only reacts to future file changes.

## When To Use `daemon` vs `serve`

- `gno serve`: browser or desktop session, API, dashboard, live indexing
- `gno daemon`: headless continuous indexing only

Avoid running both against the same index at the same time until explicit
cross-process coordination exists.

## Typical Flow

```bash
gno init ~/notes --name notes
gno index
gno daemon
```

Then keep using normal CLI commands in another terminal:

```bash
gno search "meeting notes"
gno ask "what changed this week" --answer
gno ls
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

## Troubleshooting

### "Nothing updated"

Check:

- the daemon is still running
- the changed file matches your collection pattern/include/exclude rules
- you did not start it with `--no-sync-on-start` and then expect old files to
  be imported retroactively

### "I changed config but nothing happened"

Restart the daemon. v0.30 reads config on startup.

### "I also ran gno serve"

Do not run both against the same index at the same time in v0.30.

Use:

- `gno serve` for browser/desktop sessions
- `gno daemon` for headless continuous indexing
