---
satisfies: [R5, R6]
---
# fn-109-cjk-lexical-normalization.2 Add versioned lexical analyzer schema and crash-safe backfill

## Description
Deliver add versioned lexical analyzer schema and crash-safe backfill as one implementation-sized increment.

**Size:** M
**Files:** `src/store/migrations/014-cjk-lexical-analyzer.ts`, `src/store/migrations/index.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `test/store/cjk-migration.test.ts`

### Approach
- Add the selected additive FTS/token representation, analyzer version/fingerprint, and bounded checkpointed backfill while preserving canonical text/chunks.
- Define coexistence: stale analyzer generations remain readable only through explicit fallback/rebuild state; never mix incompatible query/index representations silently.
- Make migration/backfill resume, rollback, disk-space failure, and interruption observable and cross-platform.

### Investigation targets
**Required** (read before coding):
- `src/store/migrations/index.ts`
- `src/store/sqlite/adapter.ts:1364-1510`
- `src/store/migrations/002-documents-fts.ts`
- `spec/db/schema.sql`

**Optional** (reference as needed):
- `src/core/job-manager.ts`
- `src/store/sqlite/setup.ts`

## Acceptance
- [ ] Migration records analyzer version/fingerprint and leaves original text/line spans untouched.
- [ ] Interrupted/backfill/disk-failure fixtures resume or roll back without mixed silent state.
- [ ] Existing index state returns explicit analyzer-stale/rebuild guidance during coexistence.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
