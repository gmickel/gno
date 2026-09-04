---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.1 Freeze restoration and title-variant identity oracles

## Description
Freeze restoration and title-variant identity oracles. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/ingestion-identity/ (new), test/ingestion/embedding-identity.test.ts (new), test/changes/restoration.test.ts (new)
**Touches:** [evals/fixtures/acceptance/ingestion-identity/, test/ingestion/embedding-identity.test.ts, test/changes/restoration.test.ts]

### Approach

- Promote actual-store audit matrix with same-title duplicate, whitespace-equivalent edit, Alpha/Beta title variants in both ingestion orders, delete/restore/rename and model changes.
- Freeze canonical source/chunk outputs and exact formatted embedding inputs independently. Require clean-rebuild equality after each mutation plus embedding call counts.
- Pin document+chunk+model ownership of input variants; a mirror hash alone is not sufficient. Legacy vectors with unprovable originating input must remain pending, never blessed fresh.

### Investigation targets

**Required:**
- `src/pipeline/contextual.ts:24`
- `src/embed/fingerprint.ts:21`
- `src/store/vector/stats.ts:124`
- `spec/db/schema.sql:215`
- `test/ingestion/sync-incremental.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/embedding-identity.test.ts test/changes/restoration.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Fixture demonstrates coexisting distinct title inputs under one mirror without changing title formatting.
- [ ] Repeated unchanged/restored cycles have explicit expected event and model-call counts.
- [ ] Oracle distinguishes valid shared-input reuse from wrong-title reuse and detects both missing vectors and stale vectors.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
