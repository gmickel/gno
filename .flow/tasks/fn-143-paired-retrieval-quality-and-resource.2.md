---
satisfies: [R1, R2, R5]
---
# fn-143-paired-retrieval-quality-and-resource.2 Promote isolated audit fixtures and exhaustive oracles

## Description
Promote isolated audit fixtures and exhaustive oracles. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/ (new), evals/acceptance/fixtures.ts (new), test/eval/acceptance/fixtures.test.ts (new)
**Touches:** [evals/fixtures/acceptance/, evals/acceptance/fixtures.ts, test/eval/acceptance/fixtures.test.ts]

### Approach

- Promote sanitized deterministic audit generators for eligible-top-k, 1000-chunk hydration, EN/DE/CJK reranking, expiry/restoration and title-conditioned duplicates. Preserve original negative/slower cases in provenance.
- Hash corpus, queries and expected eligible evidence. Build independent baseline/candidate temporary indexes from identical source fixtures so schema changes do not share an index.
- Keep memory fixtures/thresholds unchanged. Scenario owners may add separately identified cases; they must not overwrite an established baseline manifest.

### Investigation targets

**Required:**
- `evals/helpers/setup-db.ts:171`
- `evals/helpers/memory-harness.ts:64`
- `evals/agentic/native-fixture-store.ts:62`
- `evals/fixtures/memory/manifest.json`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/fixtures.test.ts test/eval/memory-fixtures.test.ts
bun run eval:memory
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Generation is repeatable by hash and both isolated indexes contain identical source corpus identities.
- [ ] Exhaustive eligible oracle includes document ownership and chunk language; title-variant fixture tests both ingestion orders.
- [ ] Negative controls leave original fixtures and real HOME/XDG/GNO state untouched.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
