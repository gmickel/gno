---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-104-project-aware-retrieval-affinity.4 Gate affinity with agentic evals schemas and documentation

## Description
Deliver gate affinity with agentic evals schemas and documentation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/agentic-retrieval`, `spec/output-schemas`, `docs/HOW-SEARCH-WORKS.md`, `docs/CONFIGURATION.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add project-scoped collection-choice tasks plus irrelevant-project adversarial cases to fn-97.
- Require improved correct collection choice with no evidence-accuracy regression and publish raw auxiliary-score receipts.
- Update specs/schemas/docs/skill/hosted guidance only with measured, transparent behavior.

### Investigation targets
**Required** (read before coding):
- `spec/output-schemas/query-diagnose.schema.json`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`

## Acceptance
- [ ] fn-97 project tasks improve correct collection choice without overall evidence-accuracy regression.
- [ ] Schema and parity tests cover request inputs and redacted explain metadata.
- [ ] Docs/skill/gno.sh state soft-signal, caller trust, disable/override, cap, and privacy behavior accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
