---
satisfies: [R1, R2, R3]
---
# fn-157-pin-memory-candidate-match-fixture-clock.1 Fix wall-clock dependence in candidate determinism fixtures

## Description
# Pin the memory candidate-match fixture clock

### Goal

Remove a time-dependent test failure without changing memory retrieval semantics or weakening assertions. Publish run33965952391 attempt1 on v2.0.0 failed test/core/memory.test.ts:755 because an unrelated record ID happened to begin with0900.

### Evidence

At2026-09-05T12:29:45.286Z, the Finn fixture hashes to mem-0900da6a61e2e0ff. The incoming query09:00 sanitizes to0900; the existing metadata-inclusive FTS prefix search legitimately returns that record as an extra weak candidate with similarity0. A fixed-clock scratch reproduction returns four candidates; at.287Z it returns the expected three. All20 unmodified focused attempts passed. Full diagnosis and original/fixed-clock logs: /home/gordon/.cache/agent-tmp/release200-memory-diagnosis/. Failed release log: /home/gordon/.cache/agent-tmp/release200-failed.log.

### Requirements

- R1: Inject a fixed clock through the existing MemoryServiceDeps.now seam for the determinism fixture so generated IDs and pool membership cannot depend on wall time.
- R2: Preserve the exact byte-equality, matching-mode, threshold and expected candidate assertions. Explain that FTS includes record metadata; do not claim body-only matching.
- R3: Run both lexical and semantic determinism cases plus the complete memory test file. Preserve the fixed collision/control evidence so the original failure remains reproducible.

### Boundaries

Test-fixture maintenance only. No product ranking, candidate filtering, FTS semantics, relevance labels, thresholds, release tag movement or model changes. Separate future product work would be required to adopt body-only candidate discovery.

### Acceptance

Both determinism cases pass repeatedly under fixed fixture time; complete memory tests pass. Source clock seam is reused, no new global fake clock or race with other tests. No assertion is removed or relaxed.

## Acceptance
Pin existing MemoryServiceDeps.now for fixtures; preserve all equality/threshold/candidate assertions; run both determinism cases repeatedly and full test/core/memory.test.ts; retain collision/control reproduction evidence.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
