---
satisfies: [R1, R5, R6, R7]
---
# fn-98-context-capsule-mvp.6 Complete REST MCP parity promotion proof and documentation

## Description
Deliver complete rest mcp parity promotion proof and documentation as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/serve/server.ts`, `src/mcp/tools/context.ts`, `src/mcp/server.ts`, `test/context/cross-surface-parity.test.ts`, `docs`

### Approach
- Add `POST /api/context`, `POST /api/context/verify`, `gno_context`, and `gno_context_verify` over task 5's shared `buildContextCapsule(input, ContextCapsuleRuntimeDeps)` and `verifyContextCapsuleRuntime(input, ContextCapsuleRuntimeDeps)` application boundary; construct the surface-owned runtime dependencies from `ServerContext`/`ToolContext`, and do not call `compileContextEvidence` or `verifyContextCapsule` directly from REST/MCP.
- Reuse `canonicalBuiltContextCapsuleJson`, `canonicalVerifiedContextCapsuleJson`, `formatContextCapsuleMarkdown`, and `formatContextCapsuleVerificationMarkdown` for response projection. Keep the index surface-owned as in `GnoContextInput`, preserve the exported `GnoContextErrorCode` taxonomy, and return the canonical Capsule/verification objects as structured MCP content.
- Run cross-surface canonical parity for canonical URIs, full-payload exact byte accounting, estimator-specific token accounting, safety margins, evidence scope/facet bindings, configured-context canonical keys, and omission reason counts; add adversarial JSON and Markdown projection fixtures proving source text remains escaped/hard-delimited data, then run fn-97 promotion fixtures.
- Update specs, schemas, docs, skill recipes, hosted gno.sh content, and autoresearch skill results in the same finalization task.

### Investigation targets
**Required** (read before coding):
- `src/app/context-runtime.ts`
- `src/app/context-runtime-types.ts`
- `src/app/context-format.ts`
- `src/cli/commands/context-build.ts`
- `src/cli/commands/context-verify.ts`
- `src/sdk/client.ts:654-690`
- `src/serve/routes/api.ts:3420-3586`
- `src/serve/server.ts:500-550`
- `src/serve/context.ts:64-81`
- `src/mcp/server.ts:169-182`
- `src/mcp/tools/index.ts:807-842`
- `src/mcp/tools/query.ts`
- `test/spec/schemas`

**Optional** (reference as needed):
- `docs/MCP.md`
### Key context
- Raw retrieval tools remain available; the Capsule is an additive evidence primitive.
- A promotion failure blocks product claims and requires revisiting selection/budget rules, not relaxing benchmark gates.

## Acceptance
- [ ] CLI/REST/MCP/SDK parity fixtures compare byte-identical output from the shared canonical JSON helpers and equivalent output from the shared Markdown helpers; REST/MCP do not reimplement runtime normalization, fingerprint derivation, compilation, verification, or projection.
- [ ] All fn-97 promotion gates pass and raw receipts/methodology are committed.
- [ ] Specs/docs/skill/gno.sh explain budget, gaps, exact spans, verification, prompt boundaries, and non-persistence accurately.
- [ ] Full prerelease and skill autoresearch gates pass.
- [ ] Cross-surface fixtures reject capsules that differ in final `usedBytes`, active-token accounting projection, URI canonicalization, evidence bindings, or omission `reasonCounts`.
- [ ] Adversarial evidence containing JSON/Markdown delimiters, instruction-like text, and control-looking fields cannot change either projection structure or compiler policy.
- [ ] REST/MCP parity fixtures cover task 3's fail-closed context/index drift and store/provenance error codes, shared-mirror sources, exact full-line extraction, `observedAt: null`, and literal adversarial text in both JSON and Markdown.
- [ ] Verification parity fixtures compare `canonicalContextCapsuleVerificationJson` bytes and cover content-code precedence plus available current hashes for mirror/chunk missing or corrupt states, aggregate receipt status, optional rank resolution, `currentFingerprints`/`fingerprintStatus`/canonically ordered distinct `fingerprintReasons` independent from reranking, strict canonical metadata with exact `evidence.text` bytes, pre-store contract rejection, chunked store lookup for large Capsules, and all `ContextVerifierErrorCode` failures.
- [ ] REST/MCP input schemas map to `ContextCapsuleBuildInput` with the active index supplied by the host surface, and validation/runtime failures preserve the public Context runtime/Capsule/evidence/verifier error codes rather than collapsing them into generic errors.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used the frozen canonical payload contract across all surfaces -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 materialized untrusted full-line evidence before exact canonical budget fit -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.3 exposed one strict compileContextEvidence snapshot/materialization boundary for every surface -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 exposed one non-mutating verifier and canonical receipt projection across surfaces -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 review fixes finalized fingerprint, partial-truth, exact-text, and large-Capsule parity contracts -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.5 introduced the shared Context runtime, canonical projection helpers, and public GnoContext types used by every remaining surface -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
