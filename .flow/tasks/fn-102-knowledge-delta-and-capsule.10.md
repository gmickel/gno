# fn-102-knowledge-delta-and-capsule.10 Version saved Capsule registrations for receipt CAS

## Description
Replace saved-Capsule receipt identity CAS with a durable internal registration
generation. Same-byte re-registration can change notification preferences, and
delete/recreate can reuse Capsule/file identities; stale verification work must
still be rejected without writing, advancing, or notifying.

## Acceptance
- Every registration upsert receives a monotonic durable generation from the
  global registration epoch.
- Verification loads the public registration and internal generation from one
  consistent store snapshot.
- Receipt persistence requires the expected generation and writes/advances
  nothing on conflict.
- Internal generation does not appear in public registration records, closed
  CLI/REST/MCP/SDK schemas, or notifications.
- A deterministic same-byte `local` to `none` re-registration interleaving
  rejects stale work and emits no notification; retry persists the current
  receipt and sequence.
- Delete/recreate identical-byte behavior is covered when feasible.
- Focused tests, lint, typecheck, docs verification, Flow validation, and full
  tests pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
