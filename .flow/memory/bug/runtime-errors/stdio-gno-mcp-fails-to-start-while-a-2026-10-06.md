---
title: Stdio gno mcp fails to start while a resident is writing
date: "2026-10-06"
track: bug
category: runtime-errors
module: src/mcp/server.ts
tags: [soak, fn-203, fn-204]
problem_type: runtime-error
symptoms: "gno mcp exits with Failed to initialize: database is locked during resident indexing"
root_cause: (observed via soak harness; startup DB open hits SQLITE_BUSY - unconfirmed)
resolution_type: fix
---

# Stdio gno mcp fails to start while a resident is writing

## Problem

A stdio `gno mcp` server started while `gno serve` (or the desktop app) is busy indexing exits at startup with `Failed to initialize: database is locked`. That's the common agent setup: an agent spawns `gno mcp` beside a resident that is syncing or embedding. The agent sees a dead MCP server.

Found by the fn-203 soak harness. In smoke run `bun run soak --tier smoke --seed 1`, all 32 MCP sessions started during the churn phase failed this way in one run, and 1 of 3 in another (stderr captured in the run's `logs/mcp-*.log`). The same MCP startup succeeds against an idle resident.

## Acceptance Criteria

- **R1:** Starting `gno mcp` while a resident in the same data directory is actively writing succeeds; startup waits out or avoids the writer instead of failing on `SQLITE_BUSY`.
- **R2:** A regression test starts `gno mcp` against an index under concurrent write load and asserts the `initialize` call succeeds.
- **R3:** The soak smoke tier shows no `gno mcp failed to start` in its MCP actor stats.

## Boundaries

- Read-only MCP tools only; MCP write tools keep their existing lease behaviour.
