---
satisfies: [R4, R5]
---
# fn-147-restoration-and-unchanged-embedding.4 Resolve vector candidates through eligible document owners

## Description
Resolve vector candidates through eligible document owners. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/types.ts, src/store/sqlite/adapter.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/vector-input-identity.test.ts (new)
**Touches:** [src/store/types.ts, src/store/sqlite/adapter.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/vector-input-identity.test.ts]

### Approach

- Resolve variant candidates to their current document/chunk owners before materialization; do not expand a title-specific vector to every document sharing its mirror.
- Preserve all owner egress restrictions, supported filters and public mirror/hash identifiers. Feed document/chunk eligibility into variant lookup; coordinate fn-148 contract rather than recreate global-overfetch filtering.
- Activate owner-aware retrieval atomically only after shadow backfill covers all required active bindings for the selected model/fingerprint and a final write-locked mutation-epoch check confirms freshness. Until then retain the pre-migration authoritative path without claiming new correctness; interruption resumes shadow work. After activation never fall back to unproven legacy vectors. This avoids introducing a semantic coverage drop merely to migrate schema.
- Include API/schema semantics and migration/freshness guidance in the same change without altering output shape unnecessarily.

### Investigation targets

**Required:**
- `src/store/vector/sqlite-vec.ts:274`
- `src/pipeline/vsearch.ts:122`
- `src/pipeline/hybrid.ts:257`
- `src/pipeline/filters.ts:19`
- `src/store/types.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/vector-input-identity.test.ts test/pipeline/vsearch-n1.test.ts test/pipeline/hybrid-doc-lookup.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Alpha/Beta, duplicate-owner removal and model variants retrieve only matching owners and pass clean-rebuild comparison.
- [ ] Legacy partial migration, unavailable variants and metadata errors fail/fallback truthfully without widening scope.
- [ ] Ordinary single-title corpus deterministic ranking/input outputs remain pinned.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
