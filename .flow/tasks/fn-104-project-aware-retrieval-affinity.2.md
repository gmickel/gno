---
satisfies: [R1, R2, R4, R5]
---
# fn-104-project-aware-retrieval-affinity.2 Apply one bounded explainable affinity score

## Description
Deliver apply one bounded explainable affinity score as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/project-affinity.ts`, `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/explain.ts`, `test/pipeline/project-affinity.test.ts`

### Approach
- Apply affinity after normalized base retrieval and before final cutoff/rerank blending through one shared scorer.
- Preserve candidate/filter generation and raw base scores; cap affinity so stronger non-project evidence wins.
- Define a combined auxiliary-ranking cap shared with future fn-108 content-type boost so bounded signals cannot stack past relevance.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:39-153`
- `src/pipeline/hybrid.ts:659-760`
- `src/pipeline/explain.ts`
- `src/pipeline/filters.ts`

**Optional** (reference as needed):
- `src/pipeline/rerank.ts`
- `src/pipeline/diagnose.ts`

### Key context
- Affinity is additive metadata/ranking only: it cannot create candidates or bypass collection/tag/date/exclude/egress filters.

## Acceptance
- [ ] BM25/vector/hybrid apply the same bounded contribution and preserve raw/base/final scores.
- [ ] Adversarial weak project matches cannot overtake clearly stronger non-project evidence.
- [ ] Explain/diagnose reports matched alias, source, cap, contribution, and combined auxiliary total deterministically.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
