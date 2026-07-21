---
satisfies: [R2, R3, R5, R6]
---
# fn-98-context-capsule-mvp.2 Build deterministic evidence planning and budget selection

## Description
Deliver build deterministic evidence planning and budget selection as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-compiler.ts`, `src/core/context-budget.ts`, `src/pipeline/hybrid.ts`, `test/core/context-compiler-selection.test.ts`

### Approach
- Compose existing hybrid candidates, deterministic query-facet extraction, section/chunk metadata, graph hints, and configured contexts into one candidate pool.
- Select by marginal uncovered-facet gain per token with stable tie-breaking, overlap collapse, duplicate suppression, and a per-document share cap.
- Use the active tokenizer when available; otherwise apply a documented language-aware conservative estimator and safety margin.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/hybrid.ts:659-840`
- `src/pipeline/answer.ts:201-433`
- `src/core/sections.ts`
- `src/pipeline/graph-retrieval.ts`

**Optional** (reference as needed):
- `src/pipeline/temporal.ts`
- `src/pipeline/query-language.ts`
### Key context
- Facet derivation cannot require an LLM in V1; use deterministic query modes/entities/temporal/comparison signals.
- Equal candidates tie-break by stable normalized URI, section position, and source hash.

## Acceptance
- [ ] One global budget is never exceeded after the recorded safety margin.
- [ ] Selection rewards new facet coverage, collapses duplicates/overlap, and prevents one long document consuming the bundle.
- [ ] Omitted candidates and unresolved facets carry stable reason codes and counts.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
