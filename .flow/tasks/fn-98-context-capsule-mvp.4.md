---
satisfies: [R4]
---
# fn-98-context-capsule-mvp.4 Implement non-mutating Capsule verification

## Description
Deliver implement non-mutating capsule verification as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-verifier.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `test/core/context-verifier.test.ts`

### Approach
- Build on `src/core/context-capsule-verification.ts` and resolve each saved canonical evidence identity against current active source/mirror hashes and exact spans.
- Classify unchanged, stale, missing, and reranked with explicit config/index/model fingerprint drift; never rebuild or rewrite the input Capsule.
- Separate content staleness from ranking/config drift so callers can decide whether to rebuild.

### Investigation targets
**Required** (read before coding):
- `src/store/types.ts`
- `src/store/sqlite/adapter.ts`
- `src/store/vector/freshness.ts`
- `src/core/indexed-reference.ts`

**Optional** (reference as needed):
- `src/embed/fingerprint.ts`
- `src/config/content-types.ts:128-140`

## Acceptance
- [ ] Fixtures distinguish unchanged, changed hash/span, missing source, and ranking/fingerprint drift.
- [ ] Verification leaves Capsule bytes unchanged and returns a separate canonical receipt.
- [ ] Missing/corrupt sources fail per item without aborting unrelated evidence checks.
- [ ] Verification accepts only the frozen canonical URI, evidence-ID, and exact-budget Capsule contract before it resolves evidence.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used src/core/context-capsule-verification.ts as the frozen verification contract -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
