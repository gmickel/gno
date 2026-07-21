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
- Extend deterministic citation parsing to reject malformed, stale, out-of-Capsule, and non-substantive citation artifacts before semantic verification.
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


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
