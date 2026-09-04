---
satisfies: [R3, R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.3 Generate and checkpoint vectors by actual input identity

## Description
Generate and checkpoint vectors by actual input identity. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/embed/backlog.ts, src/embed/retry.ts, src/embed/fingerprint.ts, src/store/vector/stats.ts, test/embed/backlog.test.ts, test/embed/retry.test.ts
**Touches:** [src/embed/backlog.ts, src/embed/retry.ts, src/embed/fingerprint.ts, src/store/vector/stats.ts, test/embed/backlog.test.ts, test/embed/retry.test.ts]

### Approach

- Enumerate pending document-chunk input variants instead of assuming one title per mirror; backlog cursor and retry keys include owner/variant identity so Alpha/Beta cannot collapse. Preserve exact current formatEmbeddingInput behavior and model fingerprint checks.
- Before writing a completed embedding, revalidate current document/chunk/title/model association; attach reusable existing variants without re-inference only for identical input identity.
- Checkpoint vector plus ownership atomically and retain unprocessed/ambiguous legacy entries in backlog. Coordinate fn-146 identity-before-checkpoint checks, avoiding competing definitions.

### Investigation targets

**Required:**
- `src/embed/retry.ts:160`
- `src/embed/fingerprint.ts:21`
- `src/embed/backlog.ts`
- `src/pipeline/contextual.ts:24`
- `src/store/vector/stats.ts:124`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/embed/backlog.test.ts test/embed/retry.test.ts test/ingestion/embedding-identity.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Unchanged input avoids model calls; either title ingestion order produces correct independent mappings.
- [ ] Concurrent title/content/delete/model change discards stale completion and leaves required new input pending.
- [ ] Partial batch failure preserves successful current variants and retries only incomplete work.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
