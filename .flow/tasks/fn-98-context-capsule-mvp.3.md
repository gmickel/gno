---
satisfies: [R2, R5]
---
# fn-98-context-capsule-mvp.3 Compile exact evidence spans with trust boundaries

## Description
Deliver compile exact evidence spans with trust boundaries as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-evidence.ts`, `src/pipeline/chunk-lookup.ts`, `src/core/sections.ts`, `test/core/context-evidence.test.ts`

### Approach
- Implement the `ContextCompilerDeps.materializeCandidates` seam with one strict batched loader keyed by docid: consume the caller-owned `ContextRow[]` snapshot, load active documents with `getDocumentsByDocids`, deduplicate mirror hashes for `getChunksBatch`, and preserve separate documents that share one mirror.
- Require `getContexts` to succeed, resolve configured-context provenance by docid, and compare before/after index and context fingerprints; abort instead of emitting a Capsule across either changed snapshot.
- Validate every planned candidate against the stored active document and exact chunk (`uri`, docid, source hash, `SEARCH_RESULT_PLANNER_METADATA` mirror hash/sequence, and inclusive lines), then materialize canonical LF full-line text through the aligned `materializeCandidates` result batch; use `observedAt: null` because no durable observation timestamp exists.
- Bind each already-budgeted materialized evidence item to applicable canonical configured-context IDs and requested facets; derive `evidenceId` from URI, docid, coordinates, and all three hashes.
- Hard-delimit all retrieved/clipped text as untrusted data and include trust/egress placeholders without allowing content to alter compiler policy.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/chunk-lookup.ts`
- `src/core/sections.ts`
- `src/store/types.ts:130-170`
- `src/pipeline/hybrid.ts:804-840`
- `src/core/context-compiler.ts`
- `src/pipeline/types.ts` (`SEARCH_RESULT_PLANNER_METADATA`)

**Optional** (reference as needed):
- `src/core/document-capabilities.ts`
- `src/converters/canonicalize.ts`

## Acceptance
- [ ] Every evidence item round-trips to exact indexed source lines and hashes.
- [ ] Prompt-injection fixture text remains literal evidence and cannot alter selection, schema, or tool policy.
- [ ] Missing dates/headings degrade additively without losing mandatory source identity.
- [ ] Evidence validates canonical URI/scope/collection agreement and its context/facet bindings.
- [ ] Materialization batches by docid/mirror hash, preserves same-mirror documents, and fails closed on context-load, stored provenance, chunk-coordinate, or before/after snapshot drift.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used canonical URI and evidence scope/facet bindings, not loose source identity -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 used ContextCompilerDeps.materializeCandidates, a strict ContextRow snapshot, and symbol-keyed SEARCH_RESULT_PLANNER_METADATA, not a second retrieval/materialization path -->


## Done summary
Implemented the strict shared evidence compiler and resolved independent review findings. Configured guidance now binds by canonical URI plus docid across short-docid collisions; untrusted title/heading metadata is scalar-safe and deterministically bounded to the frozen schema while passage bytes stay literal; Markdown section discovery ignores matching backtick/tilde fences; URI and hidden mirror/sequence/metadata drift fail closed. Focused, contract, typecheck, lint, Flow validation, and full Bun suites pass; only the inherited agentic byte-reduction promotion gate remains assigned to final Capsule integration.
## Evidence
- Commits: 219552540b10425e0fd1a8241a5080cdf18676e0, 1696347f5cb32f84c8c27fb49944a553a4ec1251, 54fd4461ee01c1d549da1737355bf8d53dde6392
- Tests: GATE_SKIPPED:unittest:green-receipt 5e3c26fa - baseline reused from prior post-gate pass, bun test test/core/context-guidance.test.ts test/core/context-evidence.test.ts test/core/context-evidence-metadata.test.ts test/core/context-evidence-provenance.test.ts test/core/context-compiler-selection.test.ts test/core/sections.test.ts test/spec/schemas/context-capsule.test.ts (26 pass), bun test test/context test/spec/schemas (191 pass), bun test (2498 pass, 1 skip), bun run typecheck, bun run lint:check, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json, bun run eval:agentic (inherited red before and after original task implementation: context_byte_reduction=-0.6570175070322011; all other promotion gates pass)
- PRs: