---
satisfies: [R4, R5, R6, R7]
---
# fn-102-knowledge-delta-and-capsule.4 Register saved Capsules and reverify affected evidence

## Description
Deliver register saved capsules and reverify affected evidence as one implementation-sized increment.

**Size:** M
**Files:** `src/core/capsule-registry.ts`, `src/core/capsule-reverification.ts`, `src/serve/resident-runtime.ts`, `src/core/job-manager.ts`, `test/changes/capsule-reverification.test.ts` <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.1 made background-runtime a ResidentRuntime compatibility wrapper -->

### Approach
- Register only explicitly saved Capsule path/hash/question/evidence references; keep the Capsule body user-owned at its chosen location.
- Use journal source/hash changes to enqueue bounded reverification only for referenced evidence, not every saved Capsule on every sync.
- Run `verifyContextCapsuleRuntime` once for each affected saved Capsule with `ContextCapsuleRuntimeDeps`, including optional evidence-ID keyed rank resolution; resolve and pass the registry's canonical effective index (including `default`) so a saved Capsule/index mismatch fails before evidence-store reads, and let the shared runtime derive current fingerprints from the matching config/index/model boundary. Persist/project the receipt separately with `canonicalVerifiedContextCapsuleJson`, including `currentFingerprints`, `fingerprintStatus`, and ordered `fingerprintReasons` independently from per-evidence ranking, then derive affected-question state and optional local notifications after committed changes. Use the store's batch lookup ports as-is so their internal SQLite-safe chunking supports large saved Capsules.

### Investigation targets
**Required** (read before coding):
- `src/serve/resident-runtime.ts:263-461` — shared config, jobs, sync, admission, and lifecycle ownership. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.1 moved the implementation surface -->
- `src/core/job-manager.ts`
- `src/serve/doc-events.ts`

**Optional** (reference as needed):
- `src/core/indexed-reference.ts`
- `src/serve/watch-service.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-verifier.ts`
- `src/app/context-runtime.ts`
- `src/app/context-runtime-types.ts`

### Key context
- If a saved file is missing or its canonical hash differs, report it; never reconstruct or overwrite it silently.

## Acceptance
- [ ] Only Capsules referencing changed evidence are scheduled for reverification.
- [ ] Receipts preserve partial truth for source/mirror/passage/chunk stale, missing, and corrupt states, including each current hash the verifier could determine, and distinguish those content results from ranking drift, aggregate fingerprint drift, and affected question state.
- [ ] Jobs are bounded/idempotent and notifications contain no source passage content.
- [ ] Reverification preserves the saved Capsule bytes, handles `ContextVerifierErrorCode` operation failures separately from completed stale/missing receipts, and does not treat `ranking_unavailable` as content staleness.
- [ ] A saved Capsule bound to another index reports `invalid_filter` before evidence-store reads; reverification never silently falls back to the process default or reads the wrong open index.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 exposed verifyContextCapsule and canonical non-mutating verification receipts -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 review fixes finalized independent fingerprint status, partial-truth hashes, exact evidence bytes, and chunked large-Capsule lookups -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 centralized verification dependency wiring and current fingerprint derivation in verifyContextCapsuleRuntime -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 review fixes made the Capsule/runtime canonical index match a pre-read verification invariant -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
