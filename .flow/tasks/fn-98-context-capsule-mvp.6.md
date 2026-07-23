---
satisfies: [R1, R5, R6, R7]
---
# fn-98-context-capsule-mvp.6 Complete REST MCP parity promotion proof and documentation

## Description
Deliver complete rest mcp parity promotion proof and documentation as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/serve/server.ts`, `src/serve/context.ts`, `src/mcp/tools/context.ts`, `src/mcp/server.ts`, `test/context/cross-surface-parity.test.ts`, `docs`

### Approach
- Add `POST /api/context`, `POST /api/context/verify`, `gno_context`, and `gno_context_verify` over task 5's shared `buildContextCapsule(input, ContextCapsuleRuntimeDeps)` and `verifyContextCapsuleRuntime(input, ContextCapsuleRuntimeDeps)` application boundary; construct the surface-owned runtime dependencies from `ServerContext`/`ToolContext`, retain a canonical effective index name including `default`, and do not call `compileContextEvidence` or `verifyContextCapsule` directly from REST/MCP. Verification rejects a Capsule/runtime index mismatch before evidence-store reads rather than silently switching indexes.
- Reuse `canonicalBuiltContextCapsuleJson`, `canonicalVerifiedContextCapsuleJson`, `formatContextCapsuleMarkdown`, and `formatContextCapsuleVerificationMarkdown` for full CLI, REST, SDK, and application projections. MCP `structuredContent` retains the full canonical Capsule/verification object, while MCP model-visible build text is the deterministic compact JSON `gno-context-agent-v1` projection independent of the compatibility `format` input. Preserve exact evidence bytes, configured guidance as explicitly untrusted data, and the exported `GnoContextErrorCode` taxonomy.
- Run cross-surface canonical parity for canonical URIs, full-payload exact byte accounting, estimator-specific token accounting, safety margins, evidence scope/facet bindings, configured-context canonical keys, omission reason counts, the normalized `retrieval.request`, and requested/attempted/outcome/fallback capability states. Add compact-projection lanes for title/heading, egress, context-to-guidance bindings, trust/boundary markers, and active-token estimator/fingerprint accounting. Add deferred cleanup coverage proving embedding/rerank ports settle before the shared model manager is disposed; then run fn-97 promotion fixtures without writing artifacts.
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
- [ ] CLI/REST/SDK and MCP `structuredContent` parity fixtures compare byte-identical output from the shared canonical JSON helpers and equivalent output from the shared Markdown helpers; MCP model-visible build text is deterministic compact `gno-context-agent-v1` JSON regardless of the compatibility `format` input. REST/MCP do not reimplement runtime normalization, fingerprint derivation, compilation, verification, or projection.
- [ ] All fn-97 promotion gates pass and raw receipts/methodology are committed.
- [ ] Specs/docs/skill/gno.sh explain budget, gaps, exact spans, verification, prompt boundaries, and non-persistence accurately.
- [ ] Full prerelease and skill autoresearch gates pass.
- [ ] Cross-surface fixtures reject capsules that differ in final `usedBytes`, active-token estimator/fingerprint accounting, URI canonicalization, evidence bindings, or omission `reasonCounts`; the compact projection retains title/heading, explicit egress or `unavailable`, configured guidance, trust/boundary markers, and evidence `contextIds` bindings.
- [ ] Cross-surface fixtures preserve normalized author/language/query modes, effective result/candidate limits, and graph intent in `retrieval.request`; capability states distinguish `not_requested` from attempted `unavailable`, and semantic/reranking/graph fallbacks appear only for requested unavailable attempts.
- [ ] Adversarial evidence containing JSON/Markdown delimiters, instruction-like text, and control-looking title/heading/configured-context fields cannot change projection structure or compiler policy; readable output contains exact passage bytes plus the complete canonical manifest/receipt.
- [ ] REST/MCP parity fixtures cover task 3's fail-closed context/index drift and store/provenance error codes, shared-mirror sources, exact full-line extraction, `observedAt: null`, and literal adversarial text in both JSON and Markdown.
- [ ] Verification parity fixtures compare `canonicalContextCapsuleVerificationJson` bytes and cover content-code precedence plus available current hashes for mirror/chunk missing or corrupt states, aggregate receipt status, optional rank resolution, `currentFingerprints`/`fingerprintStatus`/canonically ordered distinct `fingerprintReasons` independent from reranking, strict canonical metadata with exact `evidence.text` bytes, pre-store contract rejection, chunked store lookup for large Capsules, and all `ContextVerifierErrorCode` failures.
- [ ] REST/MCP input schemas map to `ContextCapsuleBuildInput`; unknown collections fail before model/retrieval setup, the host supplies its canonical effective index for build and verify, index mismatches fail before verification store reads, and failures preserve the public Context runtime/Capsule/evidence/verifier error codes rather than collapsing them into generic errors.
- [ ] MCP model cleanup waits for all embedding/rerank port disposals to settle before disposing `LlmAdapter`/the shared model manager, including partial initialization and cleanup failures; deferred-promise tests prove the ordering.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used the frozen canonical payload contract across all surfaces -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 materialized untrusted full-line evidence before exact canonical budget fit -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.3 exposed one strict compileContextEvidence snapshot/materialization boundary for every surface -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 exposed one non-mutating verifier and canonical receipt projection across surfaces -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.4 review fixes finalized fingerprint, partial-truth, exact-text, and large-Capsule parity contracts -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.5 introduced the shared Context runtime, canonical projection helpers, and public GnoContext types used by every remaining surface -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.5 review fixes froze retrieval requests, explicit capability outcomes, complete trust-safe Markdown, and canonical runtime-index authority -->

## Done summary
Completed Context Capsule REST/MCP parity, promotion proof, and second-review hardening.

- Registered strict closed MCP tool schemas and verified SDK-level unknown-field rejection.
- Hardened partial model initialization cleanup and exhaustive REST error/status mapping.
- Preserved the full canonical Capsule in MCP `structuredContent` while keeping model-visible text on the compact versioned `gno-context-agent-v1` JSON contract.
- Restored title/heading metadata, explicit egress, configured guidance, evidence `contextIds` bindings, trust/boundary markers, and active-token estimator/fingerprint accounting to the compact projection.
- Added adversarial cross-surface projection assertions plus deferred cleanup tests proving embedding/rerank ports settle before the shared model manager is disposed.
- Replaced the benchmark-only payload with the production serializer and retained exact deterministic replay validation.
- Updated MCP contract, user docs, skill guidance, hosted gno.sh content, and the Flow task's implementation/acceptance contract.

No-write promotion result: PASS across 48 paired cold/warm tasks; 100% Capsule success; 48.94% fewer agent calls; 44.12% fewer model-visible bytes; 100% claim linkage; deterministic replay failures: none.
## Evidence
- Commits: c3774c9, 1560540, 4e8c521, 0a5e4ad, 483ca8d, b04e531, 2d3ab3a
- Tests: bun test test/mcp/context-cleanup.test.ts test/context/cross-surface-parity.test.ts test/eval/agentic/promotion.test.ts test/eval/agentic/capsule-prototype.test.ts (15 pass, 0 fail), bun run lint:check (0 warnings, 0 errors; formatting clean), bun run eval:agentic (no-write PASS: 48 pairs, 48.94% call reduction, 44.12% context-byte reduction, 100% claim linkage), gno.sh: bun run typecheck && bun run test -- --run src/lib/product-pages.test.ts src/lib/public-truth-content.test.ts (9 pass), bun run prerelease at 06633de (2551 pass, 1 platform skip; docs verify and package smoke pass)
- PRs:
