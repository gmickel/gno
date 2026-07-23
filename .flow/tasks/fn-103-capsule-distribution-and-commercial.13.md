---
satisfies: [R5, R6]
---
# fn-103-capsule-distribution-and-commercial.13 Remove pilot cohort identity from public reports

## Description
Make pilot identity pseudonymous and fixed. Public aggregates must not expose the raw internal cohort identifier or accept client/project identities; use a non-reversible opaque public report identifier derived from the sealed aggregate if a public identifier is needed.
## Acceptance
- [ ] Cohort identifiers use a fixed pseudonymous contract and reject free-form client/project identity.
- [ ] Public output omits raw cohortId and consent/participant identities.
- [ ] Any public report identifier is non-reversible and bound to the sealed aggregate.
- [ ] Tests prove the public payload contains no raw cohort identity.
## Done summary
Replaced semantic cohort identifiers with fixed-format, generated 256-bit pseudonymous cohort keys. Public aggregates now omit the internal key and emit a one-way, seal-bound opaque report identifier. Added tests rejecting client/project identities, proving public serialization cannot reveal the internal key, and proving report identity rotates with changed outcomes.
## Evidence
- Commits: d043452
- Tests: bun test src/lib/design-partner-validation.test.ts src/lib/public-truth-content.test.ts (18 pass), bun run typecheck, bun run check
- PRs: