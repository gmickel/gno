# Make watcher lifecycle tests wait for observable completion

## Problem and evidence

Release v2.2.1 run 34062247816 attempt 1 failed two macOS tests in test/serve/watch-service-lifecycle.test.ts. At line 319, the remove/re-add case saw only old.md after a 20ms sleep, before the expected new.md sync. At line 405, the reconciliation case saw new.md first instead of old.md. Both tests coordinate asynchronous work with fixed sleeps. Timing sensitivity is a hypothesis to reproduce, not proof that watcher behavior is correct.

The full suite passed locally and in PR #230 CI on the release source. The focused lifecycle suite then passed locally: 10 tests, zero failures. Release attempt 2 is an unchanged retry. Evidence: https://github.com/gmickel/gno/actions/runs/34062247816 and local /home/gordon/.cache/agent-tmp/v2.2.1-publish-failure.log, /home/gordon/.cache/agent-tmp/v2.2.1-watcher-focused.log.

## Acceptance criteria

- Reproduce or explain each observed ordering failure under delayed scheduling; distinguish a fixture race from a watcher bug.
- Replace timing-only phase coordination with existing observable completion signals or bounded waits for the actual conditions. Preserve path ordering, invocation counts, and event assertions.
- Prove teardown drains in-flight work and restores shared mocks before the next test.
- Run the focused lifecycle file repeatedly and the required full suite, including macOS CI. Retain failing evidence and report the number of repeated runs.

## Boundaries

Keep the work focused on these lifecycle tests and any production defect actually demonstrated by the reproduction. Do not weaken assertions, raise sleeps as the sole fix, move the v2.2.1 tag, or alter release checks. This is follow-up work, not an implementation claim.
