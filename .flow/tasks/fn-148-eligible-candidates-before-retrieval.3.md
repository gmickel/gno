---
satisfies: [R2, R3]
---
# fn-148-eligible-candidates-before-retrieval.3 Select vectors and hybrid candidates from eligible units

## Description
Select vectors and hybrid candidates from eligible units. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/store/vector/types.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/eligible-top-k.test.ts (new), spec/mcp.md, docs/MCP.md
**Touches:** [src/store/vector/types.ts, src/store/vector/sqlite-vec.ts, src/pipeline/vsearch.ts, src/pipeline/hybrid.ts, test/pipeline/eligible-top-k.test.ts, spec/mcp.md, docs/MCP.md]

### Approach

- Filter exact eligible owner/chunk units before vector top-K, reusing existing scoped-distance support but extending beyond mirror allowlists for language/title variants.
- Preserve document expansion/dedup/minScore and full owner egress lineage. Fewer thanK legitimate eligible results remains valid.
- Adapt to fn-147 variant ownership if already integrated; otherwise keep the contract keyed by canonical doc/chunk identity so later variant routing composes. Do not silently revert to global-K-then-filter on metadata errors.

### Investigation targets

**Required:**
- `src/store/vector/sqlite-vec.ts:274`
- `src/pipeline/vsearch.ts:122`
- `src/pipeline/vsearch.ts:597`
- `src/pipeline/hybrid.ts:592`
- `src/pipeline/hybrid.ts:822`
- `test/store/vector/sqlite-vec-works.test.ts:129`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/pipeline/eligible-top-k.test.ts test/store/vector/sqlite-vec-works.test.ts test/pipeline/vsearch-n1.test.ts test/pipeline/hybrid-doc-lookup.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Deterministic known-vector and actual native fixtures equal exhaustive eligible selection.
- [ ] Mixed-language chunks, duplicate title owners, empty allowlists and scope intersection do not leak or starve eligible matches.
- [ ] Unchanged baseline queries retain scores, ranking and selected evidence; intended corrections are individually declared.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
