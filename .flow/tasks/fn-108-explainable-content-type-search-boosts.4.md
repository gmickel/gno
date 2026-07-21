---
satisfies: [R2, R3, R4, R6]
---
# fn-108-explainable-content-type-search-boosts.4 Run adversarial promotion evals and replace no-op documentation

## Description
Deliver run adversarial promotion evals and replace no-op documentation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/agentic-retrieval`, `test/pipeline/content-type-boost-adversarial.test.ts`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add boosted relevant/irrelevant, keyword stuffing, ties, filter bypass, and combined-affinity cases to deterministic/fn-97 suites.
- Require no evidence-accuracy/coverage regression and commit before/after receipts before promoting the field from reserved/no-op.
- Update config/search/explain/spec/skill/hosted docs with exact range, neutral value, caps, composition order, and limitations.

### Investigation targets
**Required** (read before coding):
- `docs/CONFIGURATION.md:331-360`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`

## Acceptance
- [ ] Adversarial fixtures prove cap, no filter/egress bypass, deterministic ties, and safe affinity composition.
- [ ] fn-97 records no accuracy/evidence-coverage regression with committed before/after receipts.
- [ ] All docs/skill/hosted surfaces remove the no-op wording and state the exact bounded behavior.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
