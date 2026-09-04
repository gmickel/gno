---
satisfies: [R1, R3]
---
# fn-150-incremental-graph-reconciliation-with.4 Make edge application idempotent and recover interrupted work

## Description
Make edge application idempotent and recover interrupted work. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/sqlite/adapter.ts, src/ingestion/sync.ts, test/store/graph-reference-state.test.ts (new), test/ingestion/graph-reconciliation.test.ts (new)
**Touches:** [src/store/sqlite/adapter.ts, src/ingestion/sync.ts, test/store/graph-reference-state.test.ts, test/ingestion/graph-reconciliation.test.ts]

### Approach

- Diff equal edge sets rather than delete/reinsert; preserve established edge identity/order guarantees where externally relevant.
- Commit projection-complete state only with successful graph application. Failure after source writes or midway projection leaves dirty state recoverable on next sync.
- Test retry idempotence, stale inventory, failed transaction and complete rebuild recovery. No partial projection may be exposed as authoritative complete state.

### Investigation targets

**Required:**
- `src/store/sqlite/adapter.ts:4248`
- `src/ingestion/sync.ts:1787`
- `src/store/migrations/runner.ts`
- `test/store/graph-performance.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/graph-reference-state.test.ts test/ingestion/graph-reconciliation.test.ts test/store/graph-performance.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Unchanged edges cause zero actual delete/insert churn in linked1001-document case.
- [ ] Injected failures preserve dirty recovery and next sync/full rebuild matches oracle.
- [ ] Retry does not duplicate edges or suppress legitimate change-consumer state.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
