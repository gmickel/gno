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
Replaced saved-Capsule receipt identity CAS with a durable internal
registration generation.

Migration 019 assigns every existing registration a unique generation above
the durable global epoch. Every future upsert atomically rewinds scheduler
high-water, advances the epoch, and assigns that exact generation. Verification
reads the public registration plus internal generation from one SQLite snapshot
and persists only when the generation still matches. Delete/recreate and
same-byte metadata changes therefore reject stale work without writing a
receipt, advancing the registration, or emitting an outdated notification.

The internal generation remains absent from public registration mapping,
barrel exports, structured output, and notifications. Deterministic coverage
changes `local` to `none` via identical-byte delete/recreate during persistence,
then proves bounded retry honors the current preference and reaches the current
journal high-water.
## Evidence
- Commits: f510dc9
- Tests: bun test test/changes/capsule-reverification.test.ts test/store/migrations.test.ts test/store/adapter.test.ts (61 pass, 0 fail), bun test (2848 pass, 1 expected Windows skip, 0 fail), bun run lint:check, bun run typecheck, bun run docs:verify (13 pass, 2 model-cache skips), .flow/bin/flowctl validate --all (110 specs, 319 tasks, valid)
- PRs: 143