---
satisfies: [R2, R3, R4, R6]
---
# fn-93-retrieval-context-propagation.2 Propagate context through every retrieval pipeline

## Description
Deliver propagate context through every retrieval pipeline as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/types.ts`, `test/pipeline/context-propagation.test.ts`

### Approach
- Attach resolved context at shared result assembly seams for BM25, vector, and hybrid candidates.
- Preserve the field and provenance through fusion, graph expansion, rerank, cutoffs, full-content expansion, and indexed-reference reads.
- Keep no-context result bytes/shapes compatible and prove BM25/vector/hybrid parity on the same fixture.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:115-153`
- `src/pipeline/hybrid.ts:659-840`
- `src/pipeline/types.ts:25-55`
- `src/pipeline/vsearch.ts`

**Optional** (reference as needed):
- `test/pipeline/search-n1.test.ts`
- `src/core/indexed-reference.ts`

## Acceptance
- [ ] The same document/config yields identical context across BM25, vector, and hybrid.
- [ ] Fusion, reranking, graph expansion, and full-content paths retain context without repeated store reads.
- [ ] No configured contexts preserves existing optional-field behavior and ranking.


## Done summary
Attached canonical scoped context to final BM25, vector, and hybrid results through one fail-open batch read per request. Added parity coverage for full-content, fusion/rerank, no-N+1 behavior, and preservation of the historical optional-field shape when no context is configured.
## Evidence
- Commits: 20cf8705982449046adb4d80640411c4e5dba44a
- Tests: GATE_SKIPPED:unittest:green-receipt 3a857be5 - baseline reused from prior post-gate pass, bun test test/pipeline/context-propagation.test.ts, bun test test/pipeline test/store/adapter.test.ts, bun run lint:check, .flow/bin/flowctl validate --spec fn-93-retrieval-context-propagation --json
- PRs: