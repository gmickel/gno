---
satisfies: [R2, R3]
---
# fn-150-incremental-graph-reconciliation-with.2 Persist unresolved references and projection completeness

## Description
Persist unresolved references and projection completeness. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/migrations/, src/store/types.ts, src/store/sqlite/adapter.ts, spec/db/schema.sql, test/store/graph-reference-state.test.ts (new)
**Touches:** [src/store/migrations/, src/store/types.ts, src/store/sqlite/adapter.ts, spec/db/schema.sql, test/store/graph-reference-state.test.ts]

### Approach

- Reuse doc_links for parsed links; add minimal durable frontmatter-reference inventory including unresolved target identities, rather than persisting only resolved edges.
- Store projection-version/config fingerprint and dirty/completeness state. Missing/stale inventory selects existing full reconciliation, not an unsafe partial closure.
- Index old/new resolver keys while preserving current URI/path/wiki/title precedence; prepare one lookup index per projection pass. Coordinate migration numbering/adapter edits with fn-147.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:137`
- `src/store/sqlite/adapter.ts:3432`
- `src/store/sqlite/adapter.ts:3471`
- `src/store/migrations/runner.ts`
- `spec/db/schema.sql`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/graph-reference-state.test.ts test/ingestion/graph-reconciliation.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] An outside unresolved reference remains discoverable after its target is added.
- [ ] Migration/config/version changes invalidate completeness and can rebuild idempotently.
- [ ] Inventory writes and dirty marking survive interruption without claiming complete graph state.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
