# fn-102-knowledge-delta-and-capsule.8 Suppress placeholder conversion-failure journal creates

## Description
Fix the adjacent PR #143 review finding where initial or repeatedly
never-successful conversion failures can emit a false document-change `create`.
Only a transition from prior retrievable evidence to conversion failure should
be journaled as evidence disappearance.

## Acceptance
- A first conversion failure persists error state without a document-change
  journal entry.
- A repeated conversion failure for a document that has never had retrievable
  mirror evidence also emits no journal entry.
- A changed formerly-valid document that becomes a conversion failure still
  journals the evidence disappearance transactionally.
- Regression tests, lint, typecheck, docs verification, and full tests pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
