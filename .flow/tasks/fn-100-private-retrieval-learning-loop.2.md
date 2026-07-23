---
satisfies: [R2, R3]
---
# fn-100-private-retrieval-learning-loop.2 Propagate trace identity through retrieval evidence and outcomes

## Description
Deliver propagate trace identity through retrieval evidence and outcomes as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/search.ts`, `src/pipeline/hybrid.ts`, `src/core/context-compiler.ts`, `src/cli/commands/get.ts`, `src/pipeline/answer.ts`, `test/traces/trace-propagation.test.ts`

### Approach
- Carry one trace/run ID through query planning, ranked candidates, Capsule/get/open/cite/pin outcomes, pipeline fingerprints, and exact source spans; extend the symbol-keyed `SEARCH_RESULT_PLANNER_METADATA` handoff between `searchHybrid` and `planContextEvidence` rather than adding planner-only fields to serialized `SearchResult`.
- Record normalized event types at shared core seams so CLI/REST/MCP/SDK do not invent incompatible traces.
- Treat failed/cancelled/partial requests as explicit terminal events with no fabricated outcome.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts`
- `src/pipeline/hybrid.ts`
- `src/pipeline/answer.ts`
- `src/core/indexed-reference.ts`

**Optional** (reference as needed):
- `src/mcp/tools/get.ts`
- `src/sdk/documents.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-compiler.ts`

## Acceptance
- [ ] One trace links the full query-to-evidence/citation lifecycle with stable fingerprints.
- [ ] Exact ranked spans and explicit opened/cited/pinned/judgment outcomes survive every supported path.
- [ ] Cancelled/failed requests remain inspectable and cannot be mistaken for irrelevant feedback.
- [ ] Trace propagation preserves planner retrieval rank/source/graph/mirror/sequence metadata internally without changing public search-result JSON.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.2 added SEARCH_RESULT_PLANNER_METADATA as the hybrid-to-ContextCompiler provenance seam -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
