---
satisfies: [R1, R2, R4]
---
# fn-150-incremental-graph-reconciliation-with.1 Freeze global graph oracle and mutation invalidation matrix

## Description
Freeze global graph oracle and mutation invalidation matrix. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/graph-reconciliation/ (new), test/ingestion/graph-reconciliation.test.ts (new), test/store/graph-performance.test.ts
**Touches:** [evals/fixtures/acceptance/graph-reconciliation/, test/ingestion/graph-reconciliation.test.ts, test/store/graph-performance.test.ts]

### Approach

- Promote101/1001/5001-document synthetic fixtures and count actual content reads/edge row mutations.
- Build independent full-rebuild oracle after each add/delete/restore/rename/title/config mutation, including unresolved incoming references and unique↔ambiguous targets.
- Compare normalized edge tuples plus supported unresolved/ambiguity diagnostics and preserved ordering; source disappearance removes outgoing references.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:1787`
- `src/ingestion/sync.ts:1966`
- `test/ingestion/sync-incremental.test.ts`
- `test/store/graph-performance.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/graph-reconciliation.test.ts test/store/graph-performance.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Oracle catches selected-collection-only restriction and old-identity-only invalidation.
- [ ] Unchanged fixture pins current1001reads/2000row-churn reproduction without treating it as desired golden behavior.
- [ ] Scope/active boundaries and cross-collection incoming references are represented.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
