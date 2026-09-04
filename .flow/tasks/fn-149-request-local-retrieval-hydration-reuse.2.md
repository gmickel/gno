---
satisfies: [R1, R2, R3]
---
# fn-149-request-local-retrieval-hydration-reuse.2 Share complete hydration through hybrid reranking and assembly

## Description
Share complete hydration through hybrid reranking and assembly. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/pipeline/hybrid.ts, src/pipeline/rerank.ts, src/pipeline/hydration.ts (new), test/pipeline/hydration.test.ts (new), test/pipeline/hybrid-doc-lookup.test.ts
**Touches:** [src/pipeline/hybrid.ts, src/pipeline/rerank.ts, src/pipeline/hydration.ts, test/pipeline/hydration.test.ts, test/pipeline/hybrid-doc-lookup.test.ts]

### Approach

- Pass one hydration owner through hybrid selection, rerank and assembly, reusing complete chunks already fetched instead of repeating store reads.
- Retain best-passage selection and existing4000-character preparation, dedup/index mapping and graph-added candidates; hydrate newly added candidates lazily within the same owner.
- Use fn-143 before/after model-input records as the equivalence harness. Keep fn-148 candidate-selection changes out of this task.

### Investigation targets

**Required:**
- `src/pipeline/rerank.ts:108`
- `src/pipeline/hybrid.ts:942`
- `test/pipeline/rerank-normalization.test.ts`
- `test/pipeline/hybrid-intent.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/hydration.test.ts test/pipeline/hybrid-doc-lookup.test.ts test/pipeline/rerank-normalization.test.ts test/pipeline/hybrid-intent.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Large duplicate-candidate fixture reduces repeated reads without any changed score/order/passage/model input.
- [ ] Intent/exclusion paths still receive complete required chunks; graph-added candidates retain prior behavior.
- [ ] Failure and abort release only request-owned caches.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
