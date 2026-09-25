---
title: "Windows CI: first PowerShell ACL start exceeds bun 5 s test timeout"
date: "2026-09-25"
track: bug
category: test-failures
module: src/core/windows-private-path.ts
tags: [windows, ci, request-receipts, fn-187]
problem_type: test-failure
symptoms: capture request-ID test times out at 5 s on Windows CI; CLI exits 2 after bun kills the PowerShell child
root_cause: first-in-process PowerShell DACL helper cold start (2.5-5+ s) on a fresh ledger dir
resolution_type: fix
---

## Problem
Windows CI (publish run 36179242446) failed twice on timing. `gno capture > a retried request ID replays...` hit bun's 5 s default timeout, and the first test file's `memory-fence-e2e` beforeAll hook timed out at 6.8 s. When bun timed out, it killed the still-running PowerShell ACL child ("killed 1 dangling process"). The CLI calls then returned exit 2 (REQUEST_LEDGER_UNAVAILABLE), which made the failure look like a logic bug.

## What Didn't Work
Reading the exit codes `[2, 1]` as the cause. They are downstream of the timeout.

## Solution
The first ledger opened in a Windows CI process runs `windowsPrivatePath` (a PowerShell DACL helper). The first PowerShell start of the run costs 2.5 s to over 5 s, and later starts cost about 0.4 s. Tests that open a fresh ledger dir, and early files whose first CLI calls load the command graph cold, now get a Windows-only 30 s timeout (the audit test's 35 s is the precedent). Every workflow job also has `timeout-minutes`.

## Prevention
A test that opens a request ledger (or otherwise calls `windowsPrivatePath`) needs a Windows timeout of at least 10 s (the helper's own spawn timeout) plus headroom. Compare the per-test ms timings across CI attempts: a first-in-run test that swings between 2.5 s and 5+ s is cold-start cost, not a logic bug.
