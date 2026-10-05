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
last_audited: "2026-10-05"
---

## Problem
Windows CI (publish run 36179242446) failed twice on timing. `gno capture > a retried request ID replays...` hit bun's 5 s default timeout, and the first test file's `memory-fence-e2e` beforeAll hook timed out at 6.8 s. When bun timed out, it killed the still-running PowerShell ACL child ("killed 1 dangling process"). The CLI calls then returned exit 2 (REQUEST_LEDGER_UNAVAILABLE), which made the failure look like a logic bug.

## What Didn't Work
Reading the exit codes `[2, 1]` as the cause. They are downstream of the timeout.

## Solution
Opening a fresh request ledger directory on Windows runs `windowsPrivatePath` (a PowerShell DACL helper in `src/core/windows-private-path.ts`). The first PowerShell start of a run costs 2.5 s to over 5 s; later starts cost about 0.4 s. The fix (#260) gave tests that open a fresh ledger dir, and early files whose first CLI calls load the command graph cold, a Windows-only timeout, and gave every workflow job `timeout-minutes`.

Since v2.7.1 (fn-191) the ledger writes an `.owner-only-verified` marker (`src/core/request-receipts.ts`), so later opens of an unchanged directory skip PowerShell; only a fresh or changed directory pays the cold start. The helper's own spawn timeout is now 30 s, and the capture ledger tests use `LEDGER_TEST_TIMEOUT_MS` = 60 s on Windows (`test/cli/capture.test.ts`).

## Prevention
A test that opens a fresh request ledger directory (or otherwise calls `windowsPrivatePath`) needs a Windows timeout above the helper's 30 s spawn timeout plus headroom; capture uses 60 s. Compare per-test ms timings across CI attempts: a first-in-run test that swings between 2.5 s and 5+ s is cold-start cost, not a logic bug.
