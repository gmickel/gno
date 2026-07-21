---
satisfies: [R1, R2, R3, R5]
---
# fn-108-explainable-content-type-search-boosts.2 Apply one capped boost across retrieval and explain output

## Description
Deliver apply one capped boost across retrieval and explain output as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/content-type-boost.ts`, `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/explain.ts`, `test/pipeline/content-type-boost.test.ts`

### Approach
- Transform the configured factor into a monotonic post-normalization contribution capped at plus/minus 0.05 before final cutoff/rerank blending.
- Preserve candidate/filter generation and raw/base scores; define a combined affinity-plus-content-type auxiliary cap of 0.08 with stable tie-breaking.
- Expose base score, configured factor, raw/capped contribution, combined auxiliary total, and final score in explain/diagnose.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:39-153`
- `src/pipeline/hybrid.ts:659-760`
- `src/pipeline/explain.ts`
- `src/pipeline/diagnose.ts`

**Optional** (reference as needed):
- `src/pipeline/rerank.ts`
- `src/pipeline/filters.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/pipeline/project-affinity.ts`

### Key context
- Boost cannot create candidates, bypass filters/egress, or let stacked metadata signals dominate base relevance.

## Acceptance
- [ ] BM25/vector/hybrid use one scorer and preserve deterministic raw/base/final values.
- [ ] Boost contribution never exceeds 0.05 and combined affinity/boost contribution never exceeds 0.08.
- [ ] Keyword-stuffed/irrelevant boosted candidates cannot overtake clearly relevant evidence beyond the declared cap.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
