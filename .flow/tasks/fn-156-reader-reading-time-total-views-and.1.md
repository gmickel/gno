---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-156-reader-reading-time-total-views-and.1 Implement Reader reading time, total views, and Markdown copy

## Description
Implement the parent spec across GNO exports and the shared gno.sh hosted reader.

GNO now assigns durable private note IDs, exports optional V1 IDs and an encrypted V2 roster, and passes the actual CLI/server config path. The full pinned Bun 1.4.2 suite passed 5,258 tests with two platform/opt-in skips. Subsequent focused validation passed 106 tests, including the no-flock SQLite fallback concurrency regression. Explicit changed-file type-aware lint and formatting, real export/rebuild continuity, skill evaluation (47/47), documentation verification, and isolated package smoke passed. Earlier wrong-runtime and concurrent-home-state negative evidence is preserved.

gno.sh implements reading time, current-note Markdown copy, aggregate page-open counts, bounded background writes, UUID roster validation, and identity preservation through publication/source lifecycle operations. Final site check, typecheck, 371 unit tests, 41 database integration tests, and build passed; the new migration applied twice successfully. Fable 5.1 medium reviewed both implementations with SHIP. Small review fixes were applied; the final GNO lock-fallback continuation is pending.

The task remains in progress. Final live QA and paired performance acceptance are pending. An encrypted benchmark smoke discrepancy is being diagnosed before measurements begin. No complete-spec or production fn156 acceptance is claimed yet.

Private reproducible handover: .flow/tmp/fn156-summary.md and .flow/tmp/fn156-evidence.json. Runtime evidence remains outside the repository; no synthetic credentials or encrypted payloads are committed.
## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
