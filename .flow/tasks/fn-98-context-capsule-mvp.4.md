---
satisfies: [R4]
---
# fn-98-context-capsule-mvp.4 Implement non-mutating Capsule verification

## Description
Deliver implement non-mutating capsule verification as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-verifier.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `test/core/context-verifier.test.ts`

### Approach
- Build on `src/core/context-capsule-verification.ts`; reuse `captureContextEvidenceSnapshot`, `chunkMatchesCanonicalContent`, and `extractInclusiveLines` plus the same docid/mirror batch strategy to resolve saved evidence against active documents, canonical mirror bytes, chunks, and exact spans. Factor a shared lookup helper if needed; do not call the compile-only all-or-nothing batch as the verifier's per-item policy.
- Classify unchanged, stale, missing, and reranked with explicit config/index/model fingerprint drift; never rebuild or rewrite the input Capsule.
- Separate content staleness from ranking/config drift so callers can decide whether to rebuild; use task 3's content-free activation-index fingerprint for the verification before/after snapshot and preserve per-evidence missing/stale results instead of turning one item into an operation-wide exception.

### Investigation targets
**Required** (read before coding):
- `src/store/types.ts`
- `src/store/sqlite/adapter.ts`
- `src/store/vector/freshness.ts`
- `src/core/indexed-reference.ts`
- `src/core/context-evidence.ts`
- `src/pipeline/chunk-lookup.ts`
- `src/core/sections.ts`

**Optional** (reference as needed):
- `src/embed/fingerprint.ts`
- `src/config/content-types.ts:128-140`

## Acceptance
- [ ] Fixtures distinguish unchanged, changed hash/span, missing source, and ranking/fingerprint drift.
- [ ] Verification leaves Capsule bytes unchanged and returns a separate canonical receipt.
- [ ] Missing/corrupt sources fail per item without aborting unrelated evidence checks.
- [ ] Verification accepts only the frozen canonical URI, evidence-ID, and exact-budget Capsule contract before it resolves evidence.
- [ ] Verification shares the compiler's active-document, mirror/chunk, and canonical full-line extractor and preserves per-item failure isolation.
- [ ] Verification reuses the task 3 activation-index snapshot semantics and returns canonical current source/mirror/passage hashes without mutating or recompiling the Capsule.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used src/core/context-capsule-verification.ts as the frozen verification contract -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 used strict injected materialization over preserved same-mirror search results -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.3 exposed captureContextEvidenceSnapshot and exact canonical mirror/chunk/line helpers; compileContextEvidence remains fail-closed as a whole -->


## Done summary
Implemented deterministic, non-mutating Context Capsule verification over the frozen V1 contract. Verification now validates canonical identity and exact budget before store access; re-resolves active URI/docid/source/mirror/chunk/line truth in batches with per-item isolation; distinguishes source, mirror, passage, missing, ranking, config/model, and index drift; preserves same-mirror documents; and emits a separate canonical receipt without rewriting the Capsule. Focused, contract, typecheck, lint, Flow, and full Bun suites pass. The agentic benchmark retains its inherited context-byte-reduction failure (-0.6570175070322011) while all other promotion gates pass.
## Evidence
- Commits: b7fa5ae3a136af4535ddb91dcb195dc058a154c2
- Tests: bun test test/core/context-verifier.test.ts test/core/context-evidence.test.ts test/spec/schemas/context-capsule-verification.test.ts (13 pass), bun test test/context test/spec/schemas (191 pass), bun test (2504 pass, 1 skip, 0 fail), bun run typecheck, bun run lint:check, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json, bun run eval:agentic (inherited red: context_byte_reduction=-0.6570175070322011; all other Capsule gates pass)
- PRs: