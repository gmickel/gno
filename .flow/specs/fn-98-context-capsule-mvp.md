# fn-98 Context Capsule MVP

## Goal & Context
<!-- scope: business -->

Build GNO's flagship evidence primitive: a deterministic, token-budgeted, citation-complete Context Capsule that lets an agent request a goal once and receive sufficient, diverse, verifiable evidence without orchestrating query, diagnose, get, and line-range calls manually.

## Architecture & Data Models
<!-- scope: technical -->

Add a shared `ContextCompiler` core over existing hybrid retrieval, section addressing, graph hints, source hashes, temporal metadata, and `fn-93` configured contexts. It derives query facets, retrieves candidates, selects exact sections/chunks by marginal uncovered-facet gain per token, collapses overlap/duplicates, and stops at a global token/byte budget.

Versioned `ContextCapsuleV1`:

- `schemaVersion`, `capsuleId`, goal/query, index and collection scope
- requested/used token and byte budgets
- retrieval plan, filters, depth policy, capabilities/fallbacks
- model/config/index fingerprints
- ordered `evidence[]`: URI/docid/title/heading, exact line range, extractive text, source/mirror hashes, modified/document/observed dates, configured context, trust/egress classification
- `coverage`: facets covered, unresolved facets, explicit evidence gaps
- omitted candidates with deterministic reasons
- truncation and warning state

Canonical JSON serialization excludes volatile timing. Readable Markdown is a projection of the same object. Verification re-resolves each source and reports `unchanged|stale|missing|reranked`, without silently rebuilding.

## API Contracts
<!-- scope: technical -->

- CLI: `gno context build "<goal>" --budget <tokens> [filters] --json|--md`; `gno context verify <file|-> --json|--md`.
- MCP: read-only `gno_context` and `gno_context_verify`.
- SDK: `client.context(input)` and `client.verifyContext(capsule)`.
- REST: `POST /api/context`, `POST /api/context/verify`.
- New draft-07 output schemas and contract tests; all surfaces wrap the shared compiler/verifier.
- Deterministic errors distinguish invalid budget/input, no evidence, incomplete coverage, unavailable capability, and stale verification.

## Edge Cases & Constraints
<!-- scope: technical -->

- Extractive only in V1; never fabricate a summary to fill a gap.
- Treat indexed text as untrusted data; hard-delimit source passages from instructions.
- Unicode-aware token estimation must be conservative when the active tokenizer is unavailable.
- One large document cannot consume the entire budget unless it is the only relevant source.
- Preserve exact lines after canonical mirror conversion; report source/mirror hash drift.
- Respect collection filters, indexed URI selection, context scopes, offline mode, and egress policy when present.
- Identical inputs/index/config produce byte-identical canonical JSON.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** One shared compiler emits schema-valid V1 Capsules across CLI, REST, MCP, and SDK with cross-surface parity fixtures.
- **R2:** Every evidence item carries an extractive passage, exact line range, URI/docid, source/mirror hashes, dates when known, and reproducibility fingerprints.
- **R3:** Selection enforces one global budget, collapses overlap, rewards uncovered facet coverage, and reports omitted candidates/gaps explicitly.
- **R4:** Verification classifies unchanged, stale, missing, and reranked evidence without mutating or silently rebuilding the Capsule.
- **R5:** Prompt-injection fixtures prove retrieved instructions remain data and cannot alter compiler/tool policy.
- **R6:** The `fn-97` comparison meets all encoded promotion gates: no task-accuracy loss, 25% fewer calls, 35% less context, 95% claim-span linkage, deterministic canonical output.
- **R7:** Specs, schemas, docs, skill assets, examples, and hosted gno.sh surfaces ship together with a reproducible before/after demo.

## Boundaries
<!-- scope: business -->

No lossy LLM summary requirement, autonomous multi-round research, answer generation, hidden ranking personalization, remote sharing, or removal of raw search/get tools.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

GNO has capable primitives but asks every agent to reinvent evidence gathering and budget management. A Capsule makes trustworthy context the product output and creates a reusable foundation for agents, Ask, publishing, audits, and handoffs.

### Implementation Tradeoffs
<!-- scope: technical -->

An extractive deterministic compiler is less fluent than synthesis but much easier to verify, cache, compare, and secure. Facet-aware selection improves diversity without introducing opaque autonomous loops.

## Implementation Plan

1. `fn-98-context-capsule-mvp.1` — Freeze the Context Capsule V1 contract and canonical identity (**M**)
2. `fn-98-context-capsule-mvp.2` — Build deterministic evidence planning and budget selection (**M**); depends on `fn-98-context-capsule-mvp.1`
3. `fn-98-context-capsule-mvp.3` — Compile exact evidence spans with trust boundaries (**M**); depends on `fn-98-context-capsule-mvp.2`
4. `fn-98-context-capsule-mvp.4` — Implement non-mutating Capsule verification (**M**); depends on `fn-98-context-capsule-mvp.1`, `fn-98-context-capsule-mvp.3`
5. `fn-98-context-capsule-mvp.5` — Expose Capsule build and verify through CLI and SDK (**M**); depends on `fn-98-context-capsule-mvp.3`, `fn-98-context-capsule-mvp.4`
6. `fn-98-context-capsule-mvp.6` — Complete REST MCP parity promotion proof and documentation (**M**); depends on `fn-98-context-capsule-mvp.5`

## Quick commands

```bash
bun test test/context test/spec/schemas
bun run eval:agentic
bun run lint:check
.flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json
```

## References

- `src/pipeline/hybrid.ts:804-840` — exact result/chunk assembly.
- `src/core/sections.ts` — source section addressing.
- `src/pipeline/answer.ts:435-515` — current full-document answer path.
- [OWASP prompt injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

## Early proof point

Task `fn-98-context-capsule-mvp.1` validates the core approach (a canonical schema and serializer produce byte-identical extractive evidence payloads from unchanged inputs).
If it fails, re-evaluate the Capsule lifecycle, fingerprint boundary, and canonicalization rules before continuing with `fn-98-context-capsule-mvp.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | One shared compiler emits schema-valid V1 Capsules across CLI, REST, MCP, and SDK with cross-surface parity fixtures. | fn-98-context-capsule-mvp.1, fn-98-context-capsule-mvp.5, fn-98-context-capsule-mvp.6 | — |
| R2 | Every evidence item carries an extractive passage, exact line range, URI/docid, source/mirror hashes, dates when known, and reproducibility fingerprints. | fn-98-context-capsule-mvp.1, fn-98-context-capsule-mvp.2, fn-98-context-capsule-mvp.3 | — |
| R3 | Selection enforces one global budget, collapses overlap, rewards uncovered facet coverage, and reports omitted candidates/gaps explicitly. | fn-98-context-capsule-mvp.2, fn-98-context-capsule-mvp.5 | — |
| R4 | Verification classifies unchanged, stale, missing, and reranked evidence without mutating or silently rebuilding the Capsule. | fn-98-context-capsule-mvp.4, fn-98-context-capsule-mvp.5 | — |
| R5 | Prompt-injection fixtures prove retrieved instructions remain data and cannot alter compiler/tool policy. | fn-98-context-capsule-mvp.2, fn-98-context-capsule-mvp.3, fn-98-context-capsule-mvp.6 | — |
| R6 | The `fn-97` comparison meets all encoded promotion gates: no task-accuracy loss, 25% fewer calls, 35% less context, 95% claim-span linkage, deterministic canonical output. | fn-98-context-capsule-mvp.1, fn-98-context-capsule-mvp.2, fn-98-context-capsule-mvp.6 | — |
| R7 | Specs, schemas, docs, skill assets, examples, and hosted gno.sh surfaces ship together with a reproducible before/after demo. | fn-98-context-capsule-mvp.6 | — |
