---
satisfies: [R2, R4, R5, R7]
---
# fn-101-trustworthy-synthesis-and-claim.4 Run adversarial outcome gates and ship truthful verification docs

## Description
Deliver run adversarial outcome gates and ship truthful verification docs as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic`, `test/pipeline/claim-verification-adversarial.test.ts`, `docs/HOW-SEARCH-WORKS.md`, `docs/CLI.md`, `docs/MCP.md`, `assets/skill/recipes/citation-and-provenance.md`

### Approach
- Add contradiction, insufficient evidence, stale/missing spans, malformed citations, verifier outage, and prompt-injection cases to fn-97.
- Measure final-answer accuracy and unsupported substantive claims against the baseline; block promotion on accuracy regression.
- Document verification as evidence classification, not factual guarantee, across repo/skill/hosted surfaces.

### Investigation targets
**Required** (read before coding):
- `evals/ask.eval.ts`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/recipes/citation-and-provenance.md`

**Optional** (reference as needed):
- `docs/TROUBLESHOOTING.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic`

## Acceptance
- [ ] Adversarial fixtures cover every verdict/degraded state and cannot bypass closed evidence.
- [ ] fn-97 shows no answer-accuracy regression and records the reduction in unsupported claims.
- [ ] Specs/schemas/docs/skill/gno.sh state limitations, thresholds, abstention, and verifier availability accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
