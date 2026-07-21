---
satisfies: [R4, R5, R6, R7]
---
# fn-102-knowledge-delta-and-capsule.4 Register saved Capsules and reverify affected evidence

## Description
Deliver register saved capsules and reverify affected evidence as one implementation-sized increment.

**Size:** M
**Files:** `src/core/capsule-registry.ts`, `src/core/capsule-reverification.ts`, `src/serve/background-runtime.ts`, `src/core/job-manager.ts`, `test/changes/capsule-reverification.test.ts`

### Approach
- Register only explicitly saved Capsule path/hash/question/evidence references; keep the Capsule body user-owned at its chosen location.
- Use journal source/hash changes to enqueue bounded reverification only for referenced evidence, not every saved Capsule on every sync.
- Emit unchanged/stale/missing/reranked/affected-question receipts and optional local notifications after committed changes.

### Investigation targets
**Required** (read before coding):
- `src/serve/background-runtime.ts:88-260`
- `src/core/job-manager.ts`
- `src/serve/doc-events.ts`

**Optional** (reference as needed):
- `src/core/indexed-reference.ts`
- `src/serve/watch-service.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-verifier.ts`

### Key context
- If a saved file is missing or its canonical hash differs, report it; never reconstruct or overwrite it silently.

## Acceptance
- [ ] Only Capsules referencing changed evidence are scheduled for reverification.
- [ ] Receipts distinguish source staleness, missing evidence, ranking drift, and affected question state.
- [ ] Jobs are bounded/idempotent and notifications contain no source passage content.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
