---
title: Child processes outlive a killed parent
date: "2026-10-06"
track: bug
category: runtime-errors
module: src/sessions/import-child.ts
tags: [soak, fn-203, fn-207]
problem_type: runtime-error
symptoms: "serve, session import child and updateCmd keep running after their parent is killed"
root_cause: no parent-death handling or process-group teardown for these children (confirmed by soak torture)
resolution_type: fix
related_to: [bug/runtime-errors/detached-daemon-ignores-sigterm-during-2026-10-06, bug/runtime-errors/stdio-gno-mcp-fails-to-start-while-a-2026-10-06]
---

# Child processes outlive a killed parent

## Problem

Three child processes keep running after their parent dies, which is how GNO leaves processes behind for weeks:

1. **Desktop shell to serve.** The desktop shell starts `gno serve` as a plain child and stops it with an unawaited SIGTERM. If the shell is killed (crash, force quit, SIGKILL), `serve` keeps running, holding the resident owner lock and port 3927; the next app start then finds the port taken.
2. **Serve to session import child.** `importInChildProcess` (`src/sessions/import-child.ts`) has no timeout, no kill on shutdown and no parent-death signal. A `serve` killed during an import leaves the import child (and its write-lease holder) running.
3. **`gno index` / `gno update` to `updateCmd`.** `runUpdateCmd` (`src/ingestion/sync.ts`) runs `sh -c <updateCmd>` with no timeout and outside a process group the parent tears down. Killing the CLI with SIGKILL or SIGTERM leaves the command (a hung `git` or `rsync` in practice) running.

Evidence: `bun run soak --tier torture --classes desktop-shell-kill,session-import-kill,update-cmd --contain` fails I2 with the leftover `serve`, `sessions/import-child` and `sleep 600` processes respectively.

## Acceptance Criteria

- **R1:** The desktop shell's `serve` exits when the shell dies, including on SIGKILL (for example by polling the parent pid or holding a lifeline pipe), and the shell waits for and escalates its own SIGTERM on quit.
- **R2:** The session import child exits when its parent dies and is killed on resident shutdown; the import has a bounded timeout.
- **R3:** `updateCmd` runs in its own process group that is killed when the CLI exits, on SIGTERM/SIGINT, and after a configurable timeout; a killed CLI leaves no `updateCmd` process.
- **R4:** The three soak torture classes pass I2.

## Boundaries

- macOS has no parent-death signal; the lifeline approach must work there too. Linux may use PR_SET_PDEATHSIG as the file-processor child already does.
