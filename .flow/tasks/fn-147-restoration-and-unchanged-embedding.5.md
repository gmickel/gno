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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
