---
satisfies: [R1, R2]
---
# fn-149-request-local-retrieval-hydration-reuse.1 Introduce request-owned hydration and equality counters

## Description
Introduce request-owned hydration and equality counters. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/pipeline/hydration.ts (new), test/pipeline/hydration.test.ts (new), evals/fixtures/acceptance/hydration-long-doc/
**Touches:** [src/pipeline/hydration.ts, test/pipeline/hydration.test.ts, evals/fixtures/acceptance/hydration-long-doc/]

### Approach

- Create explicit request-owned immutable raw document/chunk/content caches and in-flight deduplication; no module-global map or cached failure across requests.
- Use content hash for immutable raw data and owner/doc identity where titles differ. Avoid prepared-input caching initially; if introduced it must include query/intent/model/preset identity.
- Instrument test-only hydrated row/byte/read counts and connect the1000-chunk fixture to fn-143 exact output/model-input comparator. Preserve existing consistency semantics without long read transactions around native inference.

### Investigation targets

**Required:**
- `src/store/content-batch.ts:9`
- `src/store/types.ts:1997`
- `src/pipeline/result-context.ts`
- `test/pipeline/search-n1.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/hydration.test.ts test/pipeline/search-n1.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Repeated loads within one request deduplicate; next request after edit/missing result reads fresh state.
- [ ] Abort/completion releases ownership without clearing data still used by an active stage.
- [ ] Negative stale-input control fails parity; counters measure row volume as well as round trips.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
