---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-104-project-aware-retrieval-affinity.4 Gate affinity with agentic evals schemas and documentation

## Description
Deliver gate affinity with agentic evals schemas and documentation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/agentic-retrieval`, `spec/output-schemas`, `test/project-affinity/parity.test.ts`, `docs/HOW-SEARCH-WORKS.md`, `docs/CONFIGURATION.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add project-scoped collection-choice tasks plus irrelevant-project adversarial cases to fn-97.
- Require improved correct collection choice with no evidence-accuracy regression and publish raw auxiliary-score receipts.
- Extend the shipped parity seam for CLI `--project-root`/`--no-project-affinity` and SDK/REST/MCP `projectHints`; keep remote hints opaque, bounded to 16, and absent from reflected output.
- Update specs/schemas/docs/skill/hosted guidance only with measured, transparent behavior.
<!-- Updated by plan-sync: fn-104-project-aware-retrieval-affinity.3 shipped projectHints plus CLI --project-root/--no-project-affinity through test/project-affinity/parity.test.ts -->

### Investigation targets
**Required** (read before coding):
- `spec/output-schemas/query-diagnose.schema.json`
- `test/project-affinity/parity.test.ts`
- `docs/HOW-SEARCH-WORKS.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/MCP.md`
- `docs/SDK.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`
- `src/core/project-affinity-surface.ts`

## Acceptance
- [ ] fn-97 project tasks improve correct collection choice without overall evidence-accuracy regression.
- [ ] Schema and parity tests cover CLI `--project-root`/`--no-project-affinity`, SDK/REST/MCP `projectHints`, and redacted explain metadata without reflecting opaque hints or unrelated absolute roots.
- [ ] Docs/skill/gno.sh state soft-signal, caller trust, disable/override, cap, and privacy behavior accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
