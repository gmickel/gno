---
satisfies: [R2, R3, R4, R6]
---
# fn-60-reference-safe-file-operations-and-refactors.7 Add atomic refactor apply service and recovery receipts

## Description
Add one collection-scoped apply service that verifies the exact preview, stages the moved note and affected reference files, commits or restores the full filesystem set, records a recovery receipt, and then drives observable index convergence.

**Size:** M
**Files:** `src/core/file-refactor-service.ts`, `src/core/file-lock.ts`, `src/core/file-ops.ts`, `src/store/sqlite/change-journal-store.ts`, `test/core/file-refactor-service.test.ts`

### Approach
- Reuse capability gates, file locks, and filesystem primitives; keep content I/O Bun-first.
- Validate plan digest and every precondition fingerprint immediately before staging.
- Treat filesystem commit and reindex as explicit consecutive states.
- Make interruption and rollback state detectable without storing note content in telemetry/logs.

### Investigation targets
**Required** (read before coding):
- `src/core/file-lock.ts` — existing lock lifecycle
- `src/core/file-ops.ts:7-79` — Bun-first filesystem boundary
- `src/store/sqlite/change-journal-store.ts:74-130` — journal/receipt pattern
- `src/serve/routes/api.ts:2571-2616` — current rename execution
- `src/mcp/tools/workspace-write.ts:204-321` — independent current execution paths

**Optional** (reference as needed):
- `test/core/file-ops.test.ts` — failure/structure-operation tests
- `test/serve/api-docs-lifecycle.test.ts` — sync failure semantics

### Key context
A successful filesystem commit is not rolled back merely because reindex is temporarily unavailable. Return `applied_with_sync_pending` and enough content-free recovery context to converge safely.

## Acceptance
- [ ] Stale fingerprints, occupied targets, denied capabilities, and concurrent collection mutations fail before any user file changes.
- [ ] Failure injection at each staging/commit point proves complete apply or verified restore/recovery state across the entire file set.
- [ ] SIGINT/client disconnect and reindex failure have deterministic, documented terminal receipts.
- [ ] Successful apply refreshes index/link state; sync failure returns `applied_with_sync_pending` without repeating filesystem mutation on retry.
- [ ] Bun-first, focused service tests, and lint checks pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
