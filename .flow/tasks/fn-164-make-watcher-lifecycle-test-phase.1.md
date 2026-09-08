# fn-164-make-watcher-lifecycle-test-phase.1 Wait for watcher phases and drain fixtures on failure

## Description
Fix the two watcher lifecycle timing failures recorded in fn-164. Wait for actual first-sync and full-reconciliation phases, verify the required path batch has completed, and release/drain all mocked work in finally. Preserve every existing assertion.
## Acceptance
Original delayed scheduling probes fail and fixed probes pass. Forced assertion failure still drains queued/in-flight work before the next test. Both cases pass 20 repetitions; full local tests and hosted macOS CI pass before merge. No production change, assertion weakening, or release.
## Done summary
Replaced timing-only phase coordination in the two failing watcher lifecycle tests with bounded waits for observed sync phases and completed path batches. Added finally blocks that release all fixture gates and await service.dispose before shared mocks reset. Preserved all existing assertions. Delayed start/finish probes fail before the fix and pass afterward; a forced assertion failure drains the service and allows the next test to pass. Twenty repetitions of both watcher cases passed, as did the full local suite. Hosted macOS checks are a merge prerequisite. Evidence lives in /home/gordon/.cache/agent-tmp/fixture-fixes-probes/. No production code changed.
## Evidence
- Commits: f5ac56bbfb7d18ccb78cbaacb2c755d85d866327
- Tests: bun test: 5261 pass, 2 existing opt-in skips, 0 fail, Affected memory and watcher files: 38 pass, 0 fail, Four target tests repeated 20 times: 80 pass, 0 fail, Type-aware oxlint with explicit absolute paths: 2 files, 0 warnings/errors; oxfmt passed, Delayed watcher starts (450ms) and completions (60ms): original fails, fixed passes, Forced assertion failure: dispose drains all queued/in-flight work; next test passes, Memory collision clock .286Z fails; fixed control .287Z passes
- PRs: