---
satisfies: [R1, R2]
---
# fn-187-windows-ci-capture-request-id-flake-and.1 Implement Windows CI capture request-ID flake and job timeout

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Root cause of the Windows flake: bun's 5 s default timeout ran out during first-in-run cold starts. The first request ledger in the process spawns the PowerShell DACL helper, which takes 2.5 s to over 5 s cold and about 0.3 s warm. The first CLI calls also load the command graph cold, which took 6.8 s in the memory-fence beforeAll. At the timeout, bun killed the PowerShell child, so the CLI exit codes `[2, 1]` are a consequence, not the cause. The fix gives the two capture ledger tests and the memory-fence beforeAll a 30 s Windows-only timeout (the audit test's 35 s is the precedent), adds the calls' stderr to the replay assertion, and puts `timeout-minutes` on every workflow job (test-windows and the publish test matrix get 25). On PR #260, test-windows went green in 11 min, with the retry test at 1927 ms.

Follow-up (not built): on Windows, every CLI call with `--request-id` spawns PowerShell for the ACL check, because the verified-dir cache is per process.

Tier: session (actual_model: claude-opus-5-5)
stage: impl-review - ran (codex gpt-6-astra: round 1 NEEDS_WORK (2 findings fixed), round 2 SHIP)
## Evidence
- Commits: c26a86ede5135fdeaad9191eb29d0e6605662d4d, 1b34e11134c72ba94e6c0b3079e689fd7c6598de
- Tests: bun test test/cli/capture.test.ts test/memory-fence-e2e.test.ts test/scripts/ci.test.ts, bun test, bun run lint:check, PR #260 CI run 36183549905: test-windows success (11m); retry test 1927ms, reset test 275ms
- PRs: https://github.com/gmickel/gno/pull/260