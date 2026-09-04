---
satisfies: [R1, R2, R4]
---
# fn-150-incremental-graph-reconciliation-with.3 Reconcile affected incoming source closure during scoped sync

## Description
Reconcile affected incoming source closure during scoped sync. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/ingestion/sync.ts, src/store/sqlite/adapter.ts, test/ingestion/graph-reconciliation.test.ts (new), docs/ARCHITECTURE.md, docs/DAEMON.md
**Touches:** [src/ingestion/sync.ts, src/store/sqlite/adapter.ts, test/ingestion/graph-reconciliation.test.ts, docs/ARCHITECTURE.md, docs/DAEMON.md]

### Approach

- Union changed sources with referrers matching both old and new target identities and affected ambiguous keys; include incoming sources outside the selected collection.
- Reuse selected-ID projection and existing before/after backlink collection, extending it with unresolved reference inventory. True no-op with complete state skips global content backfill.
- Fallback to complete reconciliation whenever closure completeness cannot be established; retain current rebuild path instead of inventing a new public repair command.
- Couple scoped-sync/incoming-reference guidance to changed behavior and coordinate committed restoration events with fn-147.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:1756`
- `src/ingestion/sync.ts:1606`
- `src/ingestion/sync.ts:2342`
- `src/store/sqlite/adapter.ts:4939`
- `test/ingestion/sync-incremental.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/graph-reconciliation.test.ts test/ingestion/sync-incremental.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Every mutation equals full oracle including unresolved/ambiguous diagnostics.
- [ ] No-op avoids global content reads while target additions/removals update outside owned edges.
- [ ] Collection/config change or incomplete reference state triggers truthful full fallback.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
