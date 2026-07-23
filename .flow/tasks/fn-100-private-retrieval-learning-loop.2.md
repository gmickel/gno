---
satisfies: [R2, R3]
---
# fn-100-private-retrieval-learning-loop.2 Propagate trace identity through retrieval evidence and outcomes

## Description
Deliver propagate trace identity through retrieval evidence and outcomes as one implementation-sized increment.

**Size:** M
**Files:** `src/app/context-runtime.ts`, `src/pipeline/types.ts`, `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/core/context-compiler.ts`, `src/core/context-evidence.ts`, `src/cli/commands/get.ts`, `src/pipeline/answer.ts`, CLI/REST/MCP/SDK surface adapters, `test/traces/trace-propagation.test.ts`

### Approach
- Create one optional `RetrievalTraceSession` at the application boundary and project normalized `query`, `retrieval`, `context`, `get`, `open`, `cite`, `pin`, `capability`, and terminal events at shared core seams so CLI/REST/MCP/SDK cannot invent incompatible traces.
- Carry trace/run identity through lexical, vector, and hybrid planning, ranked candidates, Capsule/get/open/cite/pin outcomes, pipeline fingerprints, and exact source spans. Extend the symbol-keyed `SEARCH_RESULT_PLANNER_METADATA` handoff rather than adding planner-only fields to serialized `SearchResult`.
- Preserve canonical Capsule determinism: never place random trace identity inside the canonical Capsule payload or capsule ID. Return trace identity only in non-canonical surface metadata and store a context event linking the trace to the deterministic capsule ID.
- Derive exact evidence from canonical `gno://` identity plus docid/source/mirror hashes, retrieval rank/source/graph/sequence metadata, complete line ranges, and passage hashes. Ask citations must use complete source lines and record only citations retained in the final answer.
- Treat failed/cancelled/partial requests as explicit terminal states with no fabricated relevance outcome. When tracing is absent/disabled, create no IDs, perform no trace-store/fingerprint/network work, and preserve public output bytes.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts`
- `src/pipeline/vsearch.ts`
- `src/pipeline/hybrid.ts`
- `src/pipeline/answer.ts`
- `src/app/context-runtime.ts`
- `src/core/context-evidence.ts`
- `src/core/indexed-reference.ts`

**Optional** (reference as needed):
- `src/mcp/tools/get.ts`
- `src/sdk/documents.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-compiler.ts`

## Acceptance
- [ ] One trace links the full query-to-evidence/citation lifecycle with stable fingerprints.
- [ ] Exact ranked spans and explicit opened/cited/pinned outcomes survive lexical, vector, hybrid, Ask, get, and Context Capsule paths across CLI/REST/MCP/SDK surfaces.
- [ ] Cancelled/failed requests remain inspectable and cannot be mistaken for irrelevant feedback.
- [ ] Trace propagation preserves planner retrieval rank/source/graph/mirror/sequence metadata internally without changing public search-result JSON.
- [ ] Disabled tracing creates no IDs or trace work and leaves existing serialized output plus canonical Capsule bytes unchanged.
- [ ] Trace identity is returned only through non-canonical response metadata (for example REST headers, MCP `_meta`, and SDK/CLI envelopes) and never changes deterministic Capsule identity.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.2 added SEARCH_RESULT_PLANNER_METADATA as the hybrid-to-ContextCompiler provenance seam -->


## Done summary
Propagated opt-in retrieval identity and exact evidence provenance through BM25, vector, hybrid, Ask, get, Context Capsule, CLI, REST, MCP, and SDK surfaces without changing canonical payloads. Added boundary-first failure/cancellation lifecycles, pipeline-accurate capability outcomes, replay-complete filters, fail-soft retention behavior, and dead-receipt suppression. Independent review: SHIP. Commit: 531c811.
## Evidence
- Commits: 531c811
- Tests: bun test: 2651 pass, 0 fail, 1 platform skip, bun run lint:check, bun run docs:verify, flowctl validate --all, focused review: 24 pass, 0 fail
- PRs: