---
satisfies: [R4, R5]
---
# fn-103-capsule-distribution-and-commercial.12 Seal design-partner outcomes with ordered event identity

## Description
Harden the consented five-partner receipt contract with strict monotonic event identity. Results-publication approval must be the final event and seal one canonical aggregate cutoff/fingerprint; later events invalidate the approval until a new approval seals the new aggregate. Keep fn-103.4 open until deployment.
## Acceptance
- [ ] Receipts have strict ordered timestamps plus monotonic sequence identity.
- [ ] Approval before onboarding is rejected.
- [ ] Approval seals a canonical aggregate cutoff/fingerprint and is final.
- [ ] Any post-approval event invalidates the approval until reapproval.
- [ ] Focused tests cover ordering, early approval, later events, and reapproval.
## Done summary
Added schema v1.1 ordered outcome receipts with contiguous sequence numbers and strict canonical UTC timestamps. Publication approval receipts now bind the canonical aggregate cutoff and SHA-256 fingerprint. Any later outcome changes the current seal and invalidates prior approvals until all five participants reapprove. Added regression coverage for premature approvals, forged seals, post-approval events, and full-cohort reapproval.
## Evidence
- Commits: 2ad93c2
- Tests: bun test src/lib/design-partner-validation.test.ts src/lib/public-truth-content.test.ts (17 pass), bun run typecheck, bun run check
- PRs: