---
satisfies: [R1, R5, R6]
---
# fn-102-knowledge-delta-and-capsule.1 Add transactional bounded document change journal

## Description
Deliver add transactional bounded document change journal as one implementation-sized increment.

**Size:** M
**Files:** `src/store/migrations/013-change-journal.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `src/core/change-journal.ts`, `test/store/change-journal.test.ts`

### Approach
- Persist one logical journal sequence per committed create/update/rename/inactivate/reactivate operation with old/new source/mirror hashes and stable identity.
- Define retention, monotonic cursors, cursor expiry, truncation, and purge in the same transaction boundary as document state.
- Detect rename from stable identity/path transition where evidence permits; otherwise disclose delete/create rather than guessing.

### Investigation targets
**Required** (read before coding):
- `src/store/migrations/index.ts`
- `src/store/sqlite/adapter.ts`
- `src/store/types.ts`
- `src/ingestion/sync.ts:1008-1080`

**Optional** (reference as needed):
- `src/core/file-ops.ts`
- `src/serve/doc-events.ts`

## Acceptance
- [ ] Committed lifecycle operations emit deterministic old/new identity/hash records.
- [ ] No-op and rolled-back/failed writes emit no false journal entry.
- [ ] Retention, pagination cursor expiry, purge, and concurrent idempotency pass store tests.


## Done summary
Added migration 015 and a transactional, metadata-only document change journal with explicit rename semantics, opaque monotonic cursors, and bounded age/count/byte retention. Lifecycle, rollback, failed-sync, concurrency, pagination, cursor-expiry, purge, schema-version, and privacy boundaries are covered by regression tests.
## Evidence
- Commits: 83bc6d7b39d9635d80c239e4da3e19ce335046aa
- Tests: baseline: red (bun test test/store/change-journal* test/changes failed pre-edit: expected task test paths did not exist yet), bun test test/store/change-journal.test.ts test/changes/change-journal-cursor.test.ts test/store/migrations.test.ts test/store/adapter.test.ts, bun test test/ingestion/sync-incremental.test.ts test/ingestion/sync-conversion-errors.test.ts test/ingestion/sync-links.test.ts test/ingestion/sync-tags.test.ts, bun test test/store/change-journal* test/changes, bun test, bun run lint:check, .flow/bin/flowctl validate --spec fn-102-knowledge-delta-and-capsule --json
- PRs: