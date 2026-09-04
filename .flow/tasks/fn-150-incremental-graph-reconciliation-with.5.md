---
satisfies: [R4, R5]
---
# fn-150-incremental-graph-reconciliation-with.5 Drive graph consumers and verify scoped scaling

## Description
Drive graph consumers and verify scoped scaling. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/API.md, docs/MCP.md, docs/WEB-UI.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-150-incremental-graph-reconciliation-with/
**Touches:** [docs/API.md, docs/MCP.md, docs/WEB-UI.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-150-incremental-graph-reconciliation-with/]

### Approach

- Run real backlinks/graph/impact consumers after each mutation against full oracle; include outside-view degree/visibility and inactive restored documents.
- Measure no-op/narrow/broad sync over101/1001/5001documents with content reads and real SQL mutation counters; report timing as synthetic, not attribution of private vault elapsed time.
- Reconcile invalidation/rebuild guidance, complete repo gates and drive changed graph UI/hosted pages. Keep graph-response computation/cache work outside this scope.

### Investigation targets

**Required:**
- `test/core/graph-query.test.ts`
- `test/core/graph-analysis.test.ts`
- `test/serve/routes/graph-query.test.ts`
- `docs/API.md:1908`
- `docs/WEB-UI.md:693`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/core/graph-query.test.ts test/core/graph-analysis.test.ts test/serve/routes/graph-query.test.ts
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Public consumers return oracle-equal supported diagnostics/edges without domain leakage.
- [ ] Fault recovery observed through actual sync, not only store mocks.
- [ ] Full gates and changed-page QA pass; results preserve corpus/runtime identities and raw counters.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
