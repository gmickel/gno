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
Implemented deterministic Context Capsule evidence planning and resolved the independent review HOLD: bare retrieval and prefix URIs now canonicalize against non-default indexes, positive facet gain precedes relevance/cost while empty-facet evidence is redundant, one strict ContextRow snapshot feeds one aligned materialization batch, and passage-hash deduplication retains the best retrieval rank. Regression, typecheck, lint, schema, and full Bun gates pass; the pre-existing agentic context-byte promotion gate remains assigned to later Capsule integration.
## Evidence
- Commits: fdc06f9487bdb1f3a517bce7439c1bde23264da5, e75a3c4fdad6e6e61a94544de0082a5e48dcbf61, fa51be0d5413235e81fd38a63e74b1a50f02c581
- Tests: baseline: red (bun run eval:agentic failed pre-edit: context_byte_reduction_below_0.35_or_zero_denominator, -0.6570175070322011), bun test test/core/context-compiler-selection.test.ts test/pipeline/hybrid-doc-lookup.test.ts test/spec/schemas/context-capsule.test.ts (review fix: 27 pass), bun run typecheck, bun test (review fix: 2488 pass, 1 skip, 0 fail), bun test test/context test/spec/schemas (post-review: 191 pass), bun run lint:check, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json, bun run eval:agentic (inherited red unchanged before review fix: context_byte_reduction_below_0.35_or_zero_denominator, -0.6570175070322011; agent-call reduction 0.4893617021276596 passed)
- PRs: