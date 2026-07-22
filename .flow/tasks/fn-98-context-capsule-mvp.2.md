---
satisfies: [R2, R3, R5, R6]
---
# fn-98-context-capsule-mvp.2 Build deterministic evidence planning and budget selection

## Description
Deliver build deterministic evidence planning and budget selection as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-compiler.ts`, `src/core/context-budget.ts`, `src/pipeline/hybrid.ts`, `test/core/context-compiler-selection.test.ts`

### Approach
- Compose the exact chunks returned by `searchHybrid`, deterministic query-facet extraction, graph hints, `ContextResolver` provenance, and configured contexts into one candidate pool; use the shared full-payload fit callback, not a sum of passage estimates.
- Merge multi-collection candidates in stable canonical-URI order, apply URI-prefix filtering before selection, then select by marginal uncovered-facet gain under overlap/duplicate suppression and a per-document share cap.
- Account against the non-circular canonical accounting projection: persist final `usedBytes`, optionally recount active-token `usedTokens`, otherwise set `usedTokens === usedBytes`; reserve and validate both safety margins.

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
- Equal candidates tie-break by canonical URI, section position, and source hash using code-unit ordering.
- Emit the frozen omission contract, including `document_share_cap`, source/mirror hashes, and complete deterministic `reasonCounts`.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used the canonical full-payload accounting projection, not planned passage-sum token accounting -->

## Acceptance
- [ ] One global budget is never exceeded after the recorded safety margin.
- [ ] Selection rewards new facet coverage, collapses duplicates/overlap, and prevents one long document consuming the bundle.
- [ ] Omitted candidates and unresolved facets carry stable reason codes and counts.
- [ ] Candidate selection uses the shared full-payload fit callback; final `usedBytes` equals canonical Capsule UTF-8 bytes and active-token recounts use the accounting projection.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
