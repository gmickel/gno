---
satisfies: [R1, R3, R6, R7]
---
# fn-100-private-retrieval-learning-loop.5 Complete privacy migration documentation and regression gates

## Description
Deliver complete privacy migration documentation and regression gates as one implementation-sized increment.

**Size:** M
**Files:** `spec/output-schemas`, `test/traces`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`

### Approach
- Add migration/rollback, size/retention/idempotency, no-network, redaction, and purge regression suites.
- Document off-by-default controls, replay-capable versus diagnostic redaction, explicit feedback semantics, and failure recovery.
- Update contracts/skill/hosted privacy guidance and run prerelease plus autoresearch gates.

### Investigation targets
**Required** (read before coding):
- `spec/output-schemas`
- `test/spec/schemas`
- `docs/CONFIGURATION.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `docs/API.md`
- `docs/SDK.md`
## Acceptance
- [ ] All trace/list/replay/export schemas and migrations pass cross-platform tests.
- [ ] No-network and full-purge tests prove the private local contract.
- [ ] Docs and skill assets state consent, retention, redaction, explicit-label, and no-auto-personalization boundaries accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
