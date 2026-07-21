# fn-93 Retrieval Context Propagation Correctness

## Goal & Context
<!-- scope: business -->

Configured GNO contexts are persisted and synchronized, and `SearchResult.context` exists, but retrieval assembly does not consistently attach the applicable context. Make configured global, collection, and path-prefix guidance reliably reach every retrieval and answer surface so agents receive the instructions users deliberately configured.

## Architecture & Data Models
<!-- scope: technical -->

Create one shared context resolver over the indexed `contexts` table. Resolve applicable entries from result identity (`collection`, normalized relative path/URI) with deterministic precedence: global first, then collection, then matching prefixes from broadest to most specific. Return a stable joined string and provenance sufficient for tests; do not let BM25, vector, and hybrid implement separate rules.

Attach the resolved value during shared `SearchResult` construction and preserve it through fusion, reranking, full-document expansion, answer source selection, and indexed-URI reads. Cache the small context set per request/store generation, invalidated by `syncContexts` or config reload.

## API Contracts
<!-- scope: technical -->

- Existing additive `SearchResult.context?: string` becomes populated when a scope matches and remains absent otherwise.
- CLI JSON, REST search/query/ask, MCP search/vsearch/query/ask, and SDK results expose the same value.
- Human-readable output may omit context unless explicitly requested; structured output and internal answer prompts must preserve it.
- No schema-version break; update output schemas/specs where `context` is not already declared.

## Edge Cases & Constraints
<!-- scope: technical -->

- Normalize URI/path separators and reject traversal before prefix matching.
- Prefix matching is segment-aware (`projects/a` must not match `projects/ab`).
- Multiple matching scopes concatenate once in deterministic order; duplicate text is collapsed.
- Missing, stale, or malformed scopes must not fail retrieval; config validation continues to report them.
- Context is trusted user configuration, not retrieved document content, but prompt construction must still delimit both clearly.
- Added resolution must not introduce per-result SQLite queries.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A shared resolver returns the correct global, collection, and nested-prefix context with deterministic precedence and segment-safe matching.
- **R2:** BM25, vector, and hybrid results produce identical `context` values for the same document and config.
- **R3:** Fusion, rerank, full-content, Ask, indexed URI, REST, MCP, and SDK paths preserve the resolved context.
- **R4:** A request with N results performs at most one context-table read and no N+1 context queries.
- **R5:** Structured schemas, contract tests, CLI/MCP/API docs, and agent skill guidance match the shipped behavior.
- **R6:** Existing retrieval without configured contexts is byte/shape compatible except for already-optional fields.

## Boundaries
<!-- scope: business -->

No new context authoring UI, no LLM-generated context, no ranking boost from context text, no remote/team context synchronization, and no rewrite of user files.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Persisted guidance that never reaches agents violates the user contract and weakens every later Capsule and agent-evaluation feature.

### Implementation Tradeoffs
<!-- scope: technical -->

Resolve once in the shared pipeline instead of patching individual surfaces. Concatenated text keeps the public shape compatible; deterministic scope ordering makes behavior explainable and testable.

## Implementation Plan

1. `fn-93-retrieval-context-propagation.1` — Build the canonical scoped-context resolver (**M**)
2. `fn-93-retrieval-context-propagation.2` — Propagate context through every retrieval pipeline (**M**); depends on `fn-93-retrieval-context-propagation.1`
3. `fn-93-retrieval-context-propagation.3` — Complete cross-surface contracts and context guidance (**M**); depends on `fn-93-retrieval-context-propagation.2`

## Quick commands

```bash
bun test test/pipeline test/store/adapter.test.ts
bun run lint:check
.flow/bin/flowctl validate --spec fn-93-retrieval-context-propagation --json
```

## References

- `src/config/types.ts:136-165` — configured context scope contract.
- `src/store/sqlite/adapter.ts:501-558` — current persistence/read seam.
- `src/pipeline/search.ts:115-153` and `src/pipeline/hybrid.ts:700-840` — result construction paths.

## Early proof point

Task `fn-93-retrieval-context-propagation.1` validates the core approach (one canonical resolver produces stable scoped guidance with one context-table read).
If it fails, re-evaluate the context identity and caching boundary before continuing with `fn-93-retrieval-context-propagation.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | A shared resolver returns the correct global, collection, and nested-prefix context with deterministic precedence and segment-safe matching. | fn-93-retrieval-context-propagation.1 | — |
| R2 | BM25, vector, and hybrid results produce identical `context` values for the same document and config. | fn-93-retrieval-context-propagation.2 | — |
| R3 | Fusion, rerank, full-content, Ask, indexed URI, REST, MCP, and SDK paths preserve the resolved context. | fn-93-retrieval-context-propagation.2, fn-93-retrieval-context-propagation.3 | — |
| R4 | A request with N results performs at most one context-table read and no N+1 context queries. | fn-93-retrieval-context-propagation.1, fn-93-retrieval-context-propagation.2 | — |
| R5 | Structured schemas, contract tests, CLI/MCP/API docs, and agent skill guidance match the shipped behavior. | fn-93-retrieval-context-propagation.3 | — |
| R6 | Existing retrieval without configured contexts is byte/shape compatible except for already-optional fields. | fn-93-retrieval-context-propagation.1, fn-93-retrieval-context-propagation.2, fn-93-retrieval-context-propagation.3 | — |
