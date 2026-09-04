---
satisfies: [R1, R3]
---
# fn-148-eligible-candidates-before-retrieval.2 Apply lexical eligibility inside candidate selection

## Description
Apply lexical eligibility inside candidate selection. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/sqlite/adapter.ts, src/store/types.ts, test/store/eligible-top-k.test.ts (new), spec/cli.md, docs/CLI.md
**Touches:** [src/store/sqlite/adapter.ts, src/store/types.ts, test/store/eligible-top-k.test.ts, spec/cli.md, docs/CLI.md]

### Approach

- Move existing predicates inside the ranked FTS candidate domain before LIMIT, retaining FTS syntax, field weights and tie semantics.
- Reuse bulk eligibility metadata without per-document tag reads. Compare eligible join/EXISTS query plans with EXPLAIN before adding an index; keep a correctness-first eligible query for restrictive cases.
- Expose the reusable owner/chunk eligibility selection needed by the vector task. Document corrected limit semantics with the code change.

### Investigation targets

**Required:**
- `src/store/sqlite/adapter.ts:2645`
- `src/store/sqlite/adapter.ts:2716`
- `src/store/types.ts`
- `test/store/fts-lexical-regression.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/eligible-top-k.test.ts test/store/fts-lexical-regression.test.ts test/store/fts.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] 201-document regression and exhaustive lexical matrix pass at1/10 and broad limits.
- [ ] Unsupported/invalid filters retain established errors; no fn-137 AND/OR or general weighting change.
- [ ] EXPLAIN/row-count evidence supports chosen SQL shape for selective and broad cases.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
