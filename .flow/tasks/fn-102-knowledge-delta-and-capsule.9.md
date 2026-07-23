# fn-102-knowledge-delta-and-capsule.9 CAS saved Capsule verification persistence

## Description
Close the final PR #143 saved-Capsule race: an in-flight verification may load
an old registration, then persist its receipt after the same path is
re-registered to a new Capsule identity. Verification persistence must compare
the registration identity and reject stale work without advancing sequence
state.

## Acceptance
- Verification persistence atomically requires the expected current
  registration identity.
- A stale verification writes no receipt and does not advance the
  registration's last-attempted sequence.
- The resident scheduler retries and verifies the current registration while
  preserving scheduler high-water epoch CAS.
- Manual reverification handles the stale transition with a bounded retry or a
  clear failure.
- A deterministic interleaving regression proves an old receipt never attaches
  to a re-registered Capsule and the current registration reaches the current
  sequence.
- Focused tests, lint, typecheck, docs verification, Flow validation, and full
  tests pass.


## Done summary
Closed the stale saved-Capsule receipt persistence race.

Verification persistence now atomically compares the expected Capsule ID and
file hash with the current registration before writing a receipt or advancing
`lastAttemptedSequence`. A mismatch returns a conflict with no mutation.
Reverification reloads and retries once; the scheduler then uses its existing
registration-epoch CAS to retry the global high-water drain. Persistent manual
conflicts fail clearly after two bounded attempts.

Deterministic coverage re-registers changed Capsule bytes during the first
receipt write and proves the stale receipt never exists, only the replacement
Capsule notification is emitted, the replacement receipt is persisted, and the
registration/global sequences reach the current journal high-water.
## Evidence
- Commits: 2ef23ad
- Tests: bun test test/changes/capsule-reverification.test.ts (12 pass, 0 fail), bun test (2846 pass, 1 expected Windows skip, 0 fail), bun run lint:check, bun run typecheck, bun run docs:verify (13 pass, 2 model-cache skips), .flow/bin/flowctl validate --all (110 specs, 318 tasks, valid)
- PRs: 143