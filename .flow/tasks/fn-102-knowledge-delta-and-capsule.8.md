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
Stopped conversion-error placeholders from producing false Knowledge Delta
`create` events.

The conversion-failure path now journals only when the existing document has a
prior mirror/evidence identity. Initial failures and repeated failures for a
never-successful source still persist bounded error metadata but explicitly
disable change journaling. A formerly valid document that stops converting
continues to journal its evidence disappearance transactionally.

Regression coverage runs first failure, changed repeated failure, and unchanged
skip with an empty journal, alongside the existing formerly-valid transition
and saved-Capsule intersection assertions.
## Evidence
- Commits: 59658ba
- Tests: bun test test/ingestion/sync-conversion-errors.test.ts (2 pass, 0 fail), bun test (2844 pass, 1 expected Windows skip, 0 fail), bun run lint:check, bun run typecheck, bun run docs:verify (13 pass, 2 model-cache skips), .flow/bin/flowctl validate --all (110 specs, 317 tasks, valid)
- PRs: 143