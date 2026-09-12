---
satisfies: [R1, R2, R3, R4]
---
# fn-166-configurable-index-chunking.2 Policy-aware ingestion and cached mirror rechunking

## Description
Wire the policy/state foundation through existing ingestion for R1-R4.

**Size:** M
**Files:** src/ingestion/sync-options.ts, src/ingestion/types.ts, src/ingestion/sync.ts, src/ingestion/record-container.ts, src/ingestion/chunking.ts (new), direct sync callers under src/core, src/cli, src/sdk, src/mcp, src/serve, and ingestion/SDK/resident tests.
**Touches:** [src/ingestion/**, src/core/**, src/cli/**, src/sdk/**, src/mcp/**, src/serve/**, src/store/**, test/ingestion/**, test/sdk/**, test/serve/**, test/core/**, test/cli/**, test/mcp/**, test/store/**]

### Approach
- Extend withContentTypeRules at src/ingestion/sync-options.ts:21 to carry the resolved chunk policy, avoiding a wide rename-only churn. Audit every direct sync entry; default direct callers remain default.
- Prepare/claim the policy once per top-level sync, then pass a generation token through nested collection/path operations. Rechunk pending active cached mirrors using canonical Markdown and preserved path/language provenance, with a deterministic active representative for legacy content. All new file/record chunk writes use the same target and atomic application.
- Keep unchanged-file skipping and INGEST_VERSION unchanged. The cached pass handles policy changes, including returning to defaults and targeted sync. It may update all affected cached mirrors of the index because the policy is index-wide; source refresh remains scoped by the existing command/collection. Document this in the final task.
- Default-upgrade fast path performs no chunking, conversion, vector writes, or eager marker backfill for unchanged content. Preserve existing default chunker's source extension/language behavior for normal ingestion.
- Policy-only changes do not modify source identity, timestamps describing source ingestion, document metadata or journal source-change events. No source files are read or written merely to rechunk cached mirrors.
- Cached mirror application must be atomic with FTS and generation validation. A failed mirror stays pending for the next call; a conflict aborts obsolete work. Keep errors observable in normal result/error conventions.
- Keep embedding behavior of update versus index. Verify both legacy and active vector-variant stores reject obsolete chunk input, and repeated policy retains unchanged embeddings.

### Investigation targets
**Required:**
- src/ingestion/sync-options.ts
- src/ingestion/sync.ts:893
- src/ingestion/record-container.ts:355
- src/sdk/client.ts:1524
- src/serve/resident-runtime.ts:582
**Optional:**
- test/ingestion/sync-incremental.test.ts
- test/ingestion/source-availability/sync-paths.test.ts

### Quick commands
Use Bun 1.4.2 from /tmp/gno-fn166-tools/bun-linux-x64. Run bun test test/ingestion test/sdk test/serve/resident-runtime.test.ts test/store/chunking-policy.test.ts test/store/vector. Run lint/typecheck after fixes.

## Acceptance
- [ ] Real SQLite integration tests cover default upgrade with zero chunker calls, custom policy on unchanged sources, repeat no-op, and custom-to-default rollback.
- [ ] Duplicate-source targeted sync/reversion, empty mirrors, record containers, and language/code-boundary provenance are exercised.
- [ ] Failure injection proves pending mirror retries and atomic layout/FTS state; cached rechunk does not materialize unavailable sources or fake source refresh.
- [ ] CLI/helper, SDK, and resident paths carry policy consistently, and a stale client cannot overwrite a newer policy.
- [ ] Affected tests pass and active vector invalidation/preservation is verified.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
