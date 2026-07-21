---
satisfies: [R4, R5, R6]
---
# fn-94-retrieval-proven-setup-and-connector.4 Lock activation parity privacy and documentation

## Description
Deliver lock activation parity privacy and documentation as one implementation-sized increment.

**Size:** M
**Files:** `test/activation`, `test/spec/schemas`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`

### Approach
- Add cross-surface schema/parity, invalidation, privacy, and no-network regression fixtures.
- Document exit semantics: lexical proof is required; optional pending stages are allowed only with remediation.
- Update repo docs/skill and hosted gno.sh activation language, then run package and skill autoresearch gates.

### Investigation targets
**Required** (read before coding):
- `test/spec/schemas`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
## Acceptance
- [ ] Schema and parity fixtures cover every stage/status/failure code.
- [ ] Tests prove activation sends no corpus content to remote providers and stores no passage text.
- [ ] All relevant docs, skill assets, hosted install guidance, docs verification, package smoke, and skill eval are current.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
