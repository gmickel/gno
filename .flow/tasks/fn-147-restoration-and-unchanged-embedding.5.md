---
satisfies: [R1, R2, R3, R5, R6]
---
# fn-147-restoration-and-unchanged-embedding.5 Preserve unchanged chunks and restore inactive documents

## Description
Preserve unchanged chunks and restore inactive documents. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/ingestion/sync.ts, src/ingestion/record-container.ts, src/store/sqlite/adapter.ts, test/ingestion/sync-incremental.test.ts, test/changes/knowledge-delta.test.ts, docs/MEMORY.md, integrations/openclaw-gno-memory/README.md
**Touches:** [src/ingestion/sync.ts, src/ingestion/record-container.ts, src/store/sqlite/adapter.ts, test/ingestion/sync-incremental.test.ts, test/changes/knowledge-delta.test.ts, docs/MEMORY.md, integrations/openclaw-gno-memory/README.md]

### Approach

- Invalidate/reconcile document bindings transactionally on every source mutation, even when no embedding job runs. Reconcile unchanged chunks without blanket DELETE/cascade replacement; invalidate only genuinely changed sequence/input ownership. Apply to full sync, syncPaths and record containers.
- Check inactive state before unchanged short-circuit. Commit activation with the established change event in the same transaction and preserve proven vector associations.
- Test delete/restore identical, canonical edits, duplicate deletion and true rechunking. Remove obsolete OpenClaw/MEMORY known-gap text with the repaired behavior.
- Do not change source-reading/no-hydration behavior. Coordinate graph projection use of committed old/new identities with fn-150.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:214`
- `src/store/sqlite/adapter.ts:1384`
- `src/store/sqlite/adapter.ts:1466`
- `src/store/sqlite/adapter.ts:2522`
- `src/ingestion/record-container.ts:414`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/sync-incremental.test.ts test/changes/knowledge-delta.test.ts test/ingestion/embedding-identity.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Restore event appears exactly once, absent files stay inactive, repeated no-op neither emits extra history nor embeds again.
- [ ] Same-title duplicate/whitespace edits preserve valid vectors across all ingestion entrypoints.
- [ ] Injected persistence failure rolls back activation, ownership and journal consistently.

## Done summary
# fn147.5 restoration and embedding entrypoints

Status: in_progress; host owns Git/Flow, aggregate gates, running-surface acceptance and physical QA. No Git, Flow, bridges, model/GPU workloads, worktrees or subagents used. Adapter ownership acquired only after host e4e7c266 checkpoint; prior graph hunks preserved.

### Changes

CLI and SDK initialize the embedding port before force/dry-run/count/zero-pending decisions. Verified runtime identity selects the same partition for owner counting and execution through prepareEmbeddingBacklog and variant-plan. Verified ports need no dimension-probe inference. Metadata-less providers retain legacy behavior only before durable activation; metadata loss after activation fails even for forced dry runs. Automatic preparation preserves the caller's identity guard in addition to the captured runtime identity. Direct verified paths never call legacy batch writers. CLI reports owner progress against partition/collection counts; SDK surfaces index-repair failure as a store error. Public output schemas unchanged.

Forced variant work enumerates current active document/sequence owners, scopes collection before inference, bypasses reusable vectors, deduplicates equal inputs within each batch, and retains existing checkpoint identity/current-owner checks. VectorVariantStore.write updates an explicitly supplied vector even when its exact-input variant already exists; durable and vec0 rows update atomically. Zero-pending passes repair materialization from authoritative variants when epoch completeness is absent, then reactivate under the epoch fence. Durable hasActivated is preserved; unchanged active complete passes avoid index rebuilding.

SqliteAdapter.upsertChunks now reconciles by sequence: unchanged text retains the canonical row and vectors, changed/removed text deletes only that sequence and its owner bindings. Metadata changes update row metadata without resetting created_at; identical rows receive no write. UpsertDocument invalidates bindings when title/mirror changes while retaining inactive identical bindings for restoration. All remain within existing transactions. Existing sync restoration decision and record reconciliation already handle reactivation; shared adapter fixes apply to full sync, syncPaths and record persistence without changing source-reading behavior. No edits to sync.ts or record-container.ts necessary.

Removed obsolete identical-restoration known-gap text from docs/MEMORY.md and integrations/openclaw-gno-memory/README.md (actual OpenClaw doc path). Hosted docs remain queued after aggregate PR per user direction.

### Exact changed paths

- src/cli/commands/embed.ts
- src/sdk/embed.ts
- src/embed/backlog.ts
- src/embed/variant-plan.ts (new)
- src/embed/variant-backlog.ts
- src/embed/variant-retry.ts
- src/store/vector/variants.ts (host-approved supplied-vector UPDATE hunk)
- src/store/sqlite/adapter.ts (upsertDocument binding invalidation and upsertChunks reconciliation only)
- test/embed/variant-backlog.test.ts
- test/sdk/embed.test.ts
- test/ingestion/embedding-identity.test.ts
- docs/MEMORY.md
- integrations/openclaw-gno-memory/README.md

### Evidence

Baseline green: exact pre-edit task tests (sync-incremental, knowledge-delta, embedding-identity), captured baseline.log, exit 0. Similar-code investigation reused variant backlog/retry/store and existing transactional sync/record persistence, extended shared preparation and chunk reconciliation; introduced only a small internal owner-plan helper for count/force enumeration.

Final focused gate: 54 passed, 0 failed, 349 assertions across 10 files. After correcting test input nullability and making the injected trigger target the actual change_kind column, final affected test run: 10 passed, 0 failed, 77 assertions. Typed Oxlint: 11 code/test files, 0 warnings/errors. Oxfmt: all 13 changed files pass. Commands in evidence JSON. Logs: /home/gordon/.cache/agent-tmp/gno-fn147-entrypoints/{baseline,iteration,ingestion,iteration2,final-tests,final-fix-tests,lint,format}.log.

R1/R2/R5: real SQLite identical restoration over two deletion cycles, absent-file no-op, exactly one reactivate per return, injected journal failure leaves document inactive/history unchanged, retry succeeds, vector reuse needs zero embedding calls, source hash matches clean rebuild and reactivation journal. Chunk reconciliation regression verifies unchanged row identity, rollback on failed replacement preserves vectors, changed input removes stale vectors.
R3: frozen same-title duplicate and canonical whitespace oracle now proves preserved vectors with zero repeat model work. Frozen fixture/manifest/oracle untouched. Current legacy title-characterization counts explicitly updated from [1,1] to [1,0] because canonical rows now survive; it still explicitly fails the independent two-title ownership oracle, while verified variant tests prove two actual title inputs. Do not mistake this legacy-only test harness for production variant acceptance.
R4/R5: variant force counts reflect current owners and collection, storage and vec0 receive new forced values, legacy storage remains untouched; missing vec0 table repair with zero pending retains authority without model inference. SDK real SQLite integration covers verified/unverified dry-run, repeat zero backlog, force and rejection after metadata loss.
R6: coupled memory/OpenClaw documentation above.

### Remaining host acceptance

Full lint/typecheck/test/docs gate, native/runtime behavior, real CLI/API/MCP acceptance and physical QA remain host work. CLI direct command is not driven with a model here (existing CLI formatter test only); shared production processor and SDK were driven with fake deterministic ports and real SQLite. Existing record-sync suite uses its existing mocked-store fixture; shared adapter regression is real SQLite. Frozen title harness remains a legacy negative characterization as explained above. No fixture baseline refreshed. No review verdict or task completion claimed.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: 2beb8aaeafd0fd84d16111cbda3d8ec35a44ee6e
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-entrypoints bun test ./test/ingestion/sync-incremental.test.ts ./test/changes/knowledge-delta.test.ts ./test/ingestion/embedding-identity.test.ts ./test/ingestion/record-sync.test.ts ./test/embed/backlog.test.ts ./test/embed/retry.test.ts ./test/embed/variant-backlog.test.ts ./test/sdk/embed.test.ts ./test/cli/embed.test.ts ./test/store/vector/variants.test.ts — 54 pass, 0 fail, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn147-entrypoints bun test ./test/ingestion/embedding-identity.test.ts ./test/sdk/embed.test.ts — 10 pass, 0 fail after final test fixes, baseline: green; pre-edit task Quick commands exit 0, Typed Oxlint --type-aware --type-check: 11 affected code/test paths, 0 warnings/errors, Oxfmt --check: all 13 affected paths passed
- PRs: