---
satisfies: [R1, R2, R3]
---
# fn-151-atomic-readergate-capacity-and-abort.1 Implement atomic ReaderGate capacity and abort handoff

## Description
TBD

## Acceptance
Every R-ID in the parent spec acceptance criteria is satisfied; judge this task against those criteria directly.

## Done summary
ReaderGate now transfers reader ownership synchronously on release; a canceled grant transfers or returns its reserved slot exactly once. FIFO admission, configured capacity, error strings, and caller-owned release after successful acquire remain unchanged.

Status: in_progress; host owns commit, shared docs, full gates, and Flow completion. Changes confined to src/serve/resident-admission.ts and test/serve/reader-gate.test.ts.

Baseline: parent defines no Quick commands; existing resident-request + resident-concurrency suites passed (6 tests). Final focused suite: 12 pass, 0 fail, 73 assertions. Type-aware scoped lint: 0 warnings/errors. New deterministic regressions fail against original HEAD source: both capacity limits (1, 3) fail; abort-at-handoff times out (3 failures), proving the tests catch the original issues.

R1: handoff reserves capacity before fresh acquisition at limits 1/3; repeated old-owner release cannot release successor capacity. R2: abort before/at/after handoff, pre-abort, final canceled waiter/empty queue reuse, and repeated release covered. R3: real startServer listener + real resident runtime + isolated synthetic SQLite; 24 simultaneous /api/search responses all 200 and deep-equal nonempty baseline. Queued client disconnect removed its waiter; active disconnect allowed a successful follower; max active 1, final active/queued 0. QA uses an injected lexical-only ServerContext and an 8ms CPU-free operation delay to expose queues; no native model/GPU workload or production state. Successful output captured in /tmp/fn151-live-qa.log. Real API runtime was started and stopped by the probe.

QA command source: /tmp/fn151-live-qa.ts. Run with temporary FN151_QA_ROOT plus isolated GNO_CONFIG_DIR/GNO_DATA_DIR/GNO_CACHE_DIR and XDG directories, timeout 60 bun /tmp/fn151-live-qa.ts. All fixture content synthetic. No further implementation changes made after final focused suite beyond read-only original-source regression verification.

Docs implications for host: changelog fix for bounded resident/clipper reader handoff and cancellation. No new flags, schemas, errors, or public contracts. Existing queue saturation (429) and aborted/unavailable (503) semantics retained. Full repository gates and shared public docs remain host-owned.

stage: impl-review - skipped(config: user disabled plan/impl reviews)
## Evidence
- Commits:
- Tests: baseline: green - bun test test/serve/resident-request.test.ts test/serve/resident-concurrency.test.ts (6 pass), bun test test/serve/reader-gate.test.ts test/serve/resident-request.test.ts test/serve/resident-concurrency.test.ts (12 pass, 73 assertions), bunx oxlint --type-aware --type-check src/serve/resident-admission.ts test/serve/reader-gate.test.ts (0 warnings/errors), isolated timeout 60 bun /tmp/fn151-live-qa.ts (exit 0; 24 concurrent successful searches, queued/active disconnects, maxActive=1, final active=queued=0), original HEAD regression control: 3 expected failures (capacity limit 1, capacity limit 3, canceled handoff timeout)
- PRs: