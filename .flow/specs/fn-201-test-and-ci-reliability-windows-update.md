# Test and CI reliability: Windows update hang, a fragile scaling test, a stray lock file

## Goal & Context

Three loose ends from the 2.8.3 to 2.8.5 releases. Each one cost a CI rerun or leaked into a commit.

- **Windows `update` hang.**
  - `test/cli/concurrency.test.ts` ("ls can open while update is running in another process") intermittently hangs on the Windows runner. It normally takes about 4 s. It has hung in at least 6 Windows runs since 2026-09-24, which is before the per-file worker (fn-198).
  - Since fn-199 the test names the process that hung. On PR #278 (job 108905082984, run 36415182189) the report was:
    - `update` started at 244 ms and had not exited when it was killed at about 17 s, with empty stdout and stderr.
    - The concurrent `ls` started at 301 ms and exited 0 at 539 ms.
    - So `update` stalls before its first line of output, while a reader runs beside it.
  - A rerun passes in about 4 s. No cause is known. Candidates the fn-199 spec did not rule out:
    - the write lock or the busy timeout while a reader holds the database,
    - WAL checkpoint or file locking on Windows,
    - startup of the per-file worker or child,
    - model or runtime initialization that `update` performs before any output.
- **Fragile scaling test.**
  - `test/ingestion/strip.test.ts` ("code detection and link parsing stay linear with `[[open` in every row") compares 1,500 against 3,000 rows. It fails when the larger run takes more than 2.8 times as long plus 25 ms.
  - On the v2.8.4 release PR it failed once on macOS: 38.7 ms against 154.3 ms. It passed on rerun.
  - Measured locally, doubling costs 2.1 to 2.9 times up to 24,000 rows, so the bound is too tight for a shared runner at millisecond scale.
  - The sibling `x]` case has the same shape.
- **Stray lock file.**
  - A test run writes `.mcp-write.lock` into a directory literally named `undefined/` at the repository root: a write-lease path built from an undefined data directory.
  - A worker's `git add -A` committed it during fn-200. It was removed in a follow-up commit.
  - Which test, or which code path under test, builds that path is not known.

## Acceptance Criteria

- **R1:** Find why `gno update` can hang on Windows while a concurrent reader runs, and fix it.
  - **Instrument.** Capture where `update` is when it stalls, for example a timestamped phase trace to stderr or a debug log that the concurrency test already prints on timeout.
  - **Reproduce.** Run the test repeatedly on the Windows runner, for example a temporary matrix job or `workflow_dispatch` loop, until it fires with the new evidence.
  - **Fix.** Repair the cause in product code, with a regression test.
  - **If no cause is found** within the evidence gathered, record what was ruled out in this spec and leave the diagnostics in place. Raising the test timeout is not a fix.
- **R2:** The scaling tests in `test/ingestion/strip.test.ts` separate linear from quadratic with enough margin that runner noise cannot fail them. For example, compare sizes four times apart with a bound around 8 times, and take the fastest of more passes.
  - Each test must still fail against the pre-fn-199 quadratic implementation. Verify this by running it on the v2.8.3 code or an equivalent reverted copy.
  - Run it at least 20 times locally without a failure.
- **R3:** No test writes into the repository tree.
  - Find the test or code path that creates `undefined/.mcp-write.lock` and fix the undefined path at its source. If product code can build a lock path from an undefined data directory, it should fail loudly instead.
  - Do not add `undefined/` to `.gitignore`. Ignoring the symptom is not the fix.
  - A full `bun test` run leaves `git status` clean.

- **R4:** Recurring timing flakes seen during the fn-202 to fn-208 PRs (each passed on rerun, none related to the change under review) are made robust or explained:
  - Windows: `test/cli/index-protected-files.test.ts` ("reports clean PERMISSION errors and exits successfully", also a progress line after 10 s), `status-performance` (<100 ms bound), `watch-service` deletion forwarding.
  - macOS: `request-receipts-process`, `index-resume`, `test/serve/watch-service-retry-config-repair.test.ts` ("a config repair restarts the failure count", PR #292), `CollectionWatchService > forwards eligible deletion paths for inactive sync and one notification` (PR #289).
  - For each: find what the timing depends on and make the assertion depend on events instead of wall-clock windows where possible; keep the behavior under test.

## Boundaries

- R1 must not change the timeout, add retries to the test, or mark it skipped on Windows.
- R2 keeps the tests as scaling guards; they are not to be deleted or made unconditional passes.
- No product behavior change beyond what R1's root cause or R3's loud failure requires.
