---
title: Detached daemon ignores SIGTERM during startup
date: "2026-10-06"
track: bug
category: runtime-errors
module: src/cli/detach.ts
tags: [soak, fn-203, fn-206]
problem_type: runtime-error
symptoms: daemon --stop right after --detach waits 12 s and SIGKILLs
root_cause: (observed 3/3; startup window ignores SIGTERM - mechanism unconfirmed)
resolution_type: fix
related_to: [bug/runtime-errors/stdio-gno-mcp-fails-to-start-while-a-2026-10-06]
---

# Detached daemon ignores SIGTERM during startup

## Problem

`gno daemon --stop` sent immediately after `gno daemon --detach` returns waits its full 12 s budget and then SIGKILLs the daemon. The detached process does not act on SIGTERM while it is still starting up. Stopped 5 s later, the same daemon exits in about 150 ms; a foreground daemon exits on SIGTERM in about 11 ms.

Reproduced 3 of 3 times (with and without `--no-sync-on-start`), and by the fn-203 soak smoke tier (`bun run soak --tier smoke`, I5 `daemon --stop: ... after 12170 ms`). Scripts, launch agents and the desktop app that stop a freshly started resident hit a 12 s hang and an unclean kill. `gno serve --detach` likely shares the path.

## Acceptance Criteria

- **R1:** A detached daemon or serve that receives SIGTERM at any point during startup exits within the shutdown budget without escalation, releasing its locks and pid file.
- **R2:** A regression test runs `--detach` then immediately `--stop` and asserts a SIGTERM stop (not SIGKILL) well under 12 s.
- **R3:** The soak smoke tier's detach cycle passes I5.
