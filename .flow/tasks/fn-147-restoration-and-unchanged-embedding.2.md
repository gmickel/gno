---
satisfies: [R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.2 Add additive input-variant storage and ownership mapping

## Description
Add additive input-variant storage and ownership mapping. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/migrations/, src/store/vector/types.ts, src/store/vector/stats.ts, src/store/vector/sqlite-vec.ts, spec/db/schema.sql, test/store/vector/
**Touches:** [src/store/migrations/, src/store/vector/types.ts, src/store/vector/stats.ts, src/store/vector/sqlite-vec.ts, spec/db/schema.sql, test/store/vector/]

### Approach

- Introduce vector variants keyed by model identity/fingerprint, dimensions and SHA256 of exact formatted embedding input. Bind documentId, current mirrorHash, chunk sequence and model to the variant; validate all fields against the current document and chunk. Fingerprint includes effective embedding context/truncation policy as well as model identity. Preserve canonical mirror/chunk identity and public hashes.
- Use additive migration and versioned completeness metadata; do not delete legacy rows until new mappings/consumers can serve them safely. Promote only independently proven exact legacy input; even a currently unique title owner does not prove historical vector origin. All unproven legacy input needs resumable shadow backfill.
- Use variantId as the vec0 row identity in versioned tables partitioned by model/fingerprint/dimensions. Make owner association and sqlite-vec materialization transactional with the authoritative vector row. Garbage-collect a variant only after its final valid owner disappears; test crash/rollback and shared owners.

### Investigation targets

**Required:**
- `src/store/vector/types.ts`
- `src/store/vector/stats.ts:124`
- `src/store/vector/sqlite-vec.ts`
- `src/store/migrations/runner.ts`
- `spec/db/schema.sql:215`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/vector/stats.test.ts test/store/vector/sqlite-vec.test.ts test/store/vector/sqlite-vec-works.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Two title-conditioned variants coexist and resolve to distinct correct owners; same exact input/model shares a variant.
- [ ] Migration records unverifiable variants pending in shadow state, resumes safely, and cannot switch authority while required active coverage is incomplete.
- [ ] Schema/port tests prove dimensions/model isolation, last-owner deletion, and sqlite-vec mirror consistency.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
