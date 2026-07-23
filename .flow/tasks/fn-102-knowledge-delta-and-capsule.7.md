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
Closed the remaining saved-Capsule registration/scheduler race.

Registration persistence now atomically rewinds the durable scheduler
high-water sequence to the pre-load sequence and advances a registration epoch.
Scheduler drains compare that epoch before advancing; a registration that
becomes visible during a drain prevents the stale advance and triggers an
immediate retry. This covers both scheduler-advance-before-registration and
registration-during-final-advance interleavings without storing or rewriting
Capsule bodies.

Added migration 018, canonical schema updates, deterministic race regressions,
upgrade coverage, notification privacy assertions, and schema-version updates.
## Evidence
- Commits: f5a189f
- Tests: bun test test/changes/capsule-reverification.test.ts test/store/migrations.test.ts test/store/adapter.test.ts (57 pass, 0 fail), bun test (2844 pass, 1 expected Windows skip, 0 fail), bun run lint:check, bun run typecheck, bun run docs:verify (13 pass, 2 model-cache skips), .flow/bin/flowctl validate --all (110 specs, 316 tasks, valid)
- PRs: 143