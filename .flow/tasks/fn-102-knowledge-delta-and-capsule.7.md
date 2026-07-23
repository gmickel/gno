# fn-102-knowledge-delta-and-capsule.7 Close saved Capsule scheduler registration race

## Description
Close the remaining saved-Capsule registration race found during targeted PR
#143 re-review. A resident scheduler may advance its global journal high-water
while the caller-owned Capsule file is loading and before the registration is
visible, causing the later registration to miss the already-drained change.

## Acceptance
- Registration persistence atomically leaves a durable catch-up range whenever
  the scheduler advanced during file loading.
- A scheduler drain cannot overwrite a concurrent registration rewind.
- The next resident drain reverifies the affected registration and restores the
  global high-water sequence.
- Deterministic regressions cover advance-before-persistence and
  persistence-during-final-advance interleavings.
- Caller-owned Capsule bytes remain immutable and notifications remain bounded
  metadata only.
- Focused tests, lint, typecheck, docs verification, and full tests pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
