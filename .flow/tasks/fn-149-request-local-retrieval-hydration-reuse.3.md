---
satisfies: [R1, R3]
---
# fn-149-request-local-retrieval-hydration-reuse.3 Add targeted chunk batching for safe plain retrieval

## Description
Add targeted chunk batching for safe plain retrieval. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/types.ts, src/store/sqlite/adapter.ts, src/pipeline/search.ts, src/pipeline/vsearch.ts, test/store/chunks-batch-targeted.test.ts (new), test/pipeline/search-n1.test.ts, test/pipeline/vsearch-n1.test.ts
**Touches:** [src/store/types.ts, src/store/sqlite/adapter.ts, src/pipeline/search.ts, src/pipeline/vsearch.ts, test/store/chunks-batch-targeted.test.ts, test/pipeline/search-n1.test.ts, test/pipeline/vsearch-n1.test.ts]

### Approach

- Add batch-by-(mirrorHash,seq) chunk reads alongside existing whole-hash batching. Preserve exact selected sequence including plain BM25 sequence0 behavior.
- Use targeted reads only when intent/steering/document-wide exclusion or other selection semantics do not require all chunks; retain full hydration on those branches.
- Reuse request hydration keys and fn-147 ownership identity when applicable; do not conflate identical mirrors with different document titles.
- Document internal loading changes where architecture text changes, without adding a public cache knob.

### Investigation targets

**Required:**
- `src/store/types.ts:1997`
- `src/store/sqlite/adapter.ts:2586`
- `src/pipeline/search.ts:253`
- `src/pipeline/vsearch.ts:162`
- `test/pipeline/search-n1.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/chunks-batch-targeted.test.ts test/pipeline/search-n1.test.ts test/pipeline/vsearch-n1.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Plain one-result1000-chunk fixture loads only required rows/characters and has identical output.
- [ ] Full-context branches and missing-sequence behavior preserve prior error/selection semantics.
- [ ] New store batch operation handles duplicates/empty input with stable mapping and no N+1 calls.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
