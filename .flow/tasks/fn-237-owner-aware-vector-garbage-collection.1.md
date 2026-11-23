---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-237-owner-aware-vector-garbage-collection.1 Implement Owner-aware vector garbage collection

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno vec gc [--dry-run]` collects stored vector variants that no active document can use, in every partition (active, shadow, legacy-keyed), with their owner bindings and vec0 rows. It works in bounded, re-validating immediate transactions under the write lease. The dry run is read-only (no migrations, no lease). Output reports logical embedding bytes separately from the file size and free pages. Legacy `content_vectors` are excluded and counted. Compaction is documented as a separate step.

Automatic GC runs at the end of every embed pass (bounded passes included) for that pass's partition. A trigger-fed candidate queue (migration 38) makes the check one indexed probe. Each pass is capped at 5,000 candidates and 250 ms. A 7-day grace keeps the identical-restoration contract. `GNO_NO_AUTO_VECTOR_GC=1` turns it off. SDK-triggered GC takes the shared lease without waiting or defers. Failures are warnings on the CLI and SDK results.

The store's own collector and owner release keep the strict valid-owner rule. The legacy re-key moves queued candidates with their timestamps.

stage: impl-review - ran (codex 3-lens fan-out NEEDS_WORK, 9 findings; re-review NEEDS_WORK, 2; re-review NEEDS_WORK, 1; re-review SHIP) (model: gpt-6.2-sol)
stage: qa - ran (live CLI, 7 scenarios PASS, 1 P2 fixed; qa_outcome SHIP)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 3fb3aaef6c3431467c56a66b2ae763dde086f007, 87846daa96439e515e7847f60f35d9f50830d21b, 4854d6255e42f19fb54a37d06270e9253551bd16, 8fadf70a3a754c557406cae40f3cec85743b9cd8, ac9c54277ed8497280e1bb6b1b9c4c6f4abdb82f, 6d6a27e7fd139670572c491131cc136882f3e49a, 2da868fcb74c61325bf5b2f88c6a24ad6468720c
- Tests: bun test (6576 pass, 0 fail); bun run lint:check; bunx tsc --noEmit; bun run docs:verify; bun test test/store/vector/garbage.test.ts test/embed/auto-vector-gc.test.ts test/cli/vec-gc.test.ts test/sdk/embed-vector-gc.test.ts test/changes/restoration.test.ts
- PRs: