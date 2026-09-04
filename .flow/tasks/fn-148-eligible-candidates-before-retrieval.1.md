---
satisfies: [R1, R2, R3]
---
# fn-148-eligible-candidates-before-retrieval.1 Pin document and chunk eligibility with exhaustive oracles

## Description
Pin document and chunk eligibility with exhaustive oracles. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/eligible-top-k/, test/store/eligible-top-k.test.ts (new), test/pipeline/eligible-top-k.test.ts (new), src/pipeline/filters.ts
**Touches:** [evals/fixtures/acceptance/eligible-top-k/, test/store/eligible-top-k.test.ts, test/pipeline/eligible-top-k.test.ts, src/pipeline/filters.ts]

### Approach

- Define one internal eligibility contract for document ownership and chunk predicates, preserving exact supported semantics. Empty allowlist means deny-all; caller/user scopes intersect rather than replace each other.
- Promote201-document selective fixture with tags/date/author/category/path/exclude/active and mixed-language chunks, ties and duplicate owners.
- Use exhaustive eligible vectors for deterministic tests plus real embedding acceptance from fn-143. Preserve whole-document exclusion and recency/project-affinity ranking; do not treat fixed overfetch as an oracle.

### Investigation targets

**Required:**
- `src/pipeline/filters.ts:19`
- `src/pipeline/filters.ts:106`
- `src/store/sqlite/adapter.ts:2645`
- `src/pipeline/vsearch.ts:208`
- `test/store/fts-lexical-regression.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/store/eligible-top-k.test.ts test/pipeline/eligible-top-k.test.ts test/store/fts-lexical-regression.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Limits1/10 have explicit expected eligible match; all zero/deny-all/invalid-filter cases are pinned.
- [ ] Nearest ineligible-language chunk cannot consume budget even when another chunk of same mirror is eligible.
- [ ] Metadata lookup failures never widen eligibility or bypass owner policy.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
