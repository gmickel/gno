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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
