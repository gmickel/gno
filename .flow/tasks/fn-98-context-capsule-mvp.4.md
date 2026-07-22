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
Implemented deterministic, non-mutating Context Capsule verification over the frozen V1 contract and hardened the receipt after independent review. Verification now rejects noncanonical semantic input before store access, detects raw normalization-equivalent concurrent mutation, re-resolves active source/mirror/chunk/span truth in bounded batches, preserves every known current hash, distinguishes source/mirror/chunk missing and corruption states, and reports canonically ordered config/retrieval/model/tokenizer/index fingerprint drift independently from rank movement. SQLite content batching now handles more than 900 unique mirrors. Zod and Draft-07 schemas, canonicalization, fixtures, and downstream Flow plans remain aligned. Focused, schema, context, typecheck, lint, Flow, and full Bun suites pass. The agentic benchmark retains its inherited context-byte-reduction failure (-0.6570175070322011) while success, call reduction, claim linkage, and deterministic replay gates pass.
## Evidence
- Commits: b7fa5ae3a136af4535ddb91dcb195dc058a154c2, 11659c8a269e0198186641515a41a1f940a26726
- Tests: bun test test/core/context-verifier.test.ts test/spec/schemas/context-capsule-verification.test.ts test/store/adapter.test.ts (51 pass), bun test test/core/context-evidence.test.ts test/core/context-evidence-metadata.test.ts test/core/context-evidence-provenance.test.ts test/core/context-verifier.test.ts test/spec/schemas/context-capsule.test.ts test/spec/schemas/context-capsule-verification.test.ts (28 pass), bun test test/spec/schemas (192 pass), bun test (2509 pass, 1 skip, 0 fail), bun run typecheck, bun run lint:check, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json, bun run eval:agentic (inherited red: context_byte_reduction=-0.6570175070322011; baseline/capsule success=0.9583/1, call reduction=0.4894, claim linkage=1, replay hashes stable)
- PRs: