---
satisfies: [R1, R2, R3]
---
# fn-166-configurable-index-chunking.1 Chunking configuration and atomic index policy state

## Description
Implement the config and storage foundation for R1-R3, without wiring ingestion yet.

**Size:** M
**Files:** src/config/types.ts, src/config/chunking.ts (new), src/ingestion/types.ts, src/store/types.ts, src/store/sqlite/adapter.ts, src/store/sqlite/chunking-policy.ts (new), src/store/migrations/030-chunking-policy.ts (new), src/store/migrations/index.ts, spec/db/schema.sql, test/config/chunking.test.ts (new), test/store/chunking-policy.test.ts (new), related migration tests.
**Touches:** [src/config/**, src/ingestion/types.ts, src/store/**, spec/db/schema.sql, test/config/**, test/store/**]

### Approach
- Follow optional root config conventions at src/config/types.ts:564; retain createDefaultConfig output unless needed. Put canonical params, validation and stable policy identity in one dependency-light module. Keep DEFAULT_CHUNK_PARAMS compatible and byte-identical default chunk behavior. No INGEST_VERSION bump.
- Append migration after 029. Store nullable applied policy plus source-path/language provenance on content, never eager document/chunk backfills. Legacy null is default-equivalent; successful new/rebuilt layouts write explicit params/fingerprint. Reuse schema_meta for target params/fingerprint/generation.
- SqliteAdapter observes target generation at open. A transactional claim changes target only if the observed generation still matches; missing target is legacy default generation 0 and omitted/default policy must not write a new target. A stale client fails with a stable CHUNKING_POLICY_CONFLICT and reopen guidance. A freshly opened client can intentionally choose a different config; do not add config path ownership/registry or source revision hashes.
- Add small shared store operations for target claim/assertion, pending mirror enumeration and atomic layout application. Reuse upsertChunks and rebuildFtsForHash within withTransaction; assert the generation in that same transaction. Guard any ingestion layout write, including a default writer after a custom target exists. Invalid policy fails before storage mutation.
- Preserve vector invalidation at adapter.ts:2632, and confirm active variant owners cannot return obsolete rows. Keep unchanged rows/vectors. Do not refactor adjacent storage behavior.
- Pending mirror enumeration uses active document ownership and a deterministic representative with persisted relPath/languageHint when prior provenance is absent. Avoid inventing freshness for missing mirrors. New/empty content must still receive an actual applied marker after chunk application.

### Investigation targets
**Required:**
- src/config/types.ts
- src/ingestion/types.ts
- src/store/sqlite/adapter.ts:688
- src/store/migrations/009-content-type-rule-fingerprint.ts
- src/store/vector/variants.ts
**Optional:**
- test/store/migrations.test.ts
- test/store/vector/stats.test.ts

### Quick commands
Use PATH=/tmp/gno-fn166-tools/bun-linux-x64:$PATH. Run bun test test/config test/store/chunking-policy.test.ts test/store/migrations.test.ts test/store/chunks-batch-targeted.test.ts test/store/vector/stats.test.ts. Run lint/typecheck once focused tests pass.

## Acceptance
- [ ] R1 input validation covers omitted, partial, explicit defaults, zero/negative/fractional/non-finite/unsafe maxTokens, and overlap below 0/above 0.5.
- [ ] Opening/migrating an existing default index leaves its documents, chunks, vector owners, and timestamps unchanged.
- [ ] Two real SQLite adapters prove stale target claims and obsolete layout commits fail; reverting custom to default advances generation.
- [ ] Forced layout/FTS failure rolls back applied marker and chunks together; duplicate source rows observe one applied mirror policy.
- [ ] Focused tests and lint/typecheck pass, with no dependency edits or algorithm changes.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
