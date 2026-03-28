---
layout: feature
title: Daemon Mode
headline: Keep GNO Fresh Without the Web UI
description: Run GNO as a headless long-running watcher process. gno daemon keeps the same watch, sync, and embedding loop alive for terminal, agent, and local automation workflows.
keywords: gno daemon, continuous indexing, headless watcher, local daemon, background indexing, terminal workflow
icon: rocket
slug: daemon-mode
permalink: /features/daemon-mode/
og_image: /assets/images/og/og-template.png
benefits:
  - Continuous indexing without opening the browser
  - Reuses the same watch/sync/embed runtime as gno serve
  - Great fit for CLI, skills, and local automation
  - Foreground process keeps lifecycle simple and observable
  - Supports --no-sync-on-start for watcher-only startup
  - Works with --offline and manual download policy
commands:
  - "gno daemon"
  - "gno daemon --no-sync-on-start"
  - "nohup gno daemon > /tmp/gno-daemon.log 2>&1 &"
---

## Why It Exists

Sometimes you want GNO to stay current, but you do not want a browser tab or
desktop shell open all day.

`gno daemon` gives you the same watch, sync, and embed loop as `gno serve`,
just without the HTTP server and UI layer.

## Good Fits

- terminal-first workflows
- local agents installed via skill or MCP-adjacent shell flows
- always-on note/project directories
- small home-server or workstation setups

## Start It

```bash
gno daemon
```

It stays in the foreground in v0.30.

If you want supervision:

```bash
nohup gno daemon > /tmp/gno-daemon.log 2>&1 &
```

## Skip The Initial Sync

```bash
gno daemon --no-sync-on-start
```

Use that when the index is already current and you only want to react to future
file changes.

## `daemon` vs `serve`

| Command | Best for |
| :------ | :------- |
| `gno serve` | browser sessions, desktop shell, REST API, dashboard |
| `gno daemon` | headless continuous indexing only |

Avoid running both against the same index at the same time in v0.30.

## Typical Workflow

```bash
gno init ~/notes --name notes
gno index
gno daemon
```

Then use normal CLI commands in another terminal:

```bash
gno search "auth rollout"
gno ask "what changed this week" --answer
gno ls
```

[Daemon guide →](/docs/DAEMON/)
