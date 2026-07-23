---
satisfies: [R1, R2, R3, R6]
---
# fn-101-trustworthy-synthesis-and-claim.1 Define claim verification semantics and deterministic hygiene

## Description
Deliver define claim verification semantics and deterministic hygiene as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/claim-verification.ts`, `spec/output-schemas/claim-verification.schema.json`, `test/pipeline/claim-verification.test.ts`

### Approach
- Define substantive-claim segmentation, coverage denominator, supported/contradicted/insufficient/uncertain verdicts, and explicit abstention text.
- Extend deterministic citation parsing to reject malformed, out-of-Capsule, and non-substantive citation artifacts; when freshness is supplied, consume `verifyContextCapsule` evidence receipts and reject any citation whose `contentStatus` is not `unchanged` before semantic verification. Preserve exact `evidence.text` bytes during citation matching; do not normalize them as verifier metadata.
- Keep contradiction distinct from missing evidence and include reason codes plus exact evidence IDs.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/answer.ts:114-178`
- `spec/output-schemas/ask.schema.json`

**Optional** (reference as needed):
- `evals/ask.eval.ts`
- `src/core/sections.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-capsule.ts`
- `src/core/context-verifier.ts`

## Acceptance
- [ ] Fixtures classify supported, contradicted, insufficient, and uncertain claims distinctly.
- [ ] Malformed/stale/out-of-Capsule citations cannot count as support.
- [ ] Coverage and abstention thresholds are deterministic and surface-independent.
- [ ] Capsule freshness consumes the canonical verification receipt by evidence ID; `stale`/`missing` never count as support, while ranking status and aggregate fingerprint/index drift remain distinct from content invalidity and cannot invalidate otherwise unchanged evidence.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 exposed verifyContextCapsule with per-evidence content and ranking statuses -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 review fixes made fingerprint status independent from ranking/content and preserved exact evidence text bytes -->


## Done summary
Defined deterministic, Capsule-bound claim verification: exact UTF-16 spans, strict freshness and evidence identity, four-state semantic contract, 100% coverage abstention, bounded citation hygiene, and closed Zod/JSON schemas.
## Evidence
- Commits: 90bacb5
- Tests: bun test test/pipeline/claim-verification.test.ts test/spec/schemas/claim-verification.test.ts test/pipeline/answer.test.ts (26 pass), bun run lint:check, bun test test/spec/schemas (213 pass, worker)
- PRs: