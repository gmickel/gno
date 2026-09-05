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
# fn-148.2 handover

Status: in_progress. Host owns Flow, git, review/QA acceptance and full aggregate gates; worker made no commits or lifecycle mutations.

Moved all existing SQL lexical owner filters ahead of BM25 candidate LIMIT; removed fixed 10x metadata overfetch. Added reusable internal buildEligibleDocumentQuery in src/store/sqlite/eligibility.ts and DocumentEligibilityOptions. Predicate semantics, FTS syntax/weights/ties, managed-memory scope/supersession and existing lexical recency/project-affinity 3x candidate budget/scoring remain unchanged. searchBm25 now forwards caller mirror allowlist (empty denies all) and whole-document exclusions before its candidate budget. Exclusions stream a bulk owner/chunk query using existing JavaScript case folding; tags use indexed EXISTS, no N+1 tag reads. No migration or index added.

Owned files: src/store/sqlite/adapter.ts, src/store/sqlite/eligibility.ts (new), src/store/types.ts, src/pipeline/search.ts (host-approved extension), test/store/eligible-top-k.test.ts, spec/cli.md, docs/CLI.md.

Baseline: green, bun test ./test/store/eligible-top-k.test.ts ./test/store/fts-lexical-regression.test.ts ./test/store/fts.test.ts (pre-edit). Baseline commit from task1 cb3421f6; shared branch advanced concurrently before editing. No shared .flow/tmp mutation.

Verification: 76 tests /317 assertions pass across lexical/store/pipeline suites. Core memory and fn-143 acceptance comparator tests pass separately. Typed Oxlint and Oxfmt targeted checks pass; git diff --check passes. Required 201-document starvation characterization now asserts unchanged exhaustive target at K=1/10/201/300. Added broad/empty/combined filter matrix with exact raw BM25 score/order parity, caller scope intersection and real searchBm25 exclusion/allowlist calls. Fixture source/manifest and frozen fn-143 identities unchanged.

SQL evidence: notes/fn148.2-sql-evidence.json records exact queries, params, actual enumerated ranked row counts, EXPLAIN and single-call timings for IN vs correlated EXISTS. Chosen IN keeps the existing FTS rowid domain, uses idx_documents_active and indexed doc_tags ownership, and ranks 1 selective /200 broad rows before LIMIT. No index justified by this small fixture. Timings are observational, not statistically valid scaling evidence. Exclusion scan streams rather than retaining all chunk text; broad exclusion cost belongs in task4 scaling QA.

Limitations: no native vector work, no GPU or live DB, no hosted-site edits. No formal review verdict, full project gates or complete live QA claim. fn-143 comparator unit tests were run; no full paired workload/candidate manifest was generated here. Language remains reserved in lexical store options, matching prior contract. Existing lexical snippet post-exclusion and recency/affinity ranking stay untouched. Follow-on task .3 owns vector/hybrid integration, task .4 scaling/QA; host queues hosted docs after aggregate PR.

Logs: /home/gordon/.cache/agent-tmp/gno-fn148-lexical/{baseline,focused,memory-comparator,lint,format}.log.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: d5a98ca52acaab949f66dcb992b76f448e799145
- Tests: baseline: green, bun test ./test/store/eligible-top-k.test.ts ./test/store/fts-lexical-regression.test.ts ./test/store/fts.test.ts ./test/pipeline/search-quality.test.ts ./test/pipeline/project-affinity.test.ts ./test/pipeline/search-n1.test.ts ./test/pipeline/eligible-top-k.test.ts, bun test ./test/core/memory.test.ts ./test/eval/acceptance/runner.test.ts, bunx oxlint --type-aware --type-check src/store/sqlite/adapter.ts src/store/sqlite/eligibility.ts src/store/types.ts src/pipeline/search.ts test/store/eligible-top-k.test.ts, bunx oxfmt --check src/store/sqlite/adapter.ts src/store/sqlite/eligibility.ts src/store/types.ts src/pipeline/search.ts test/store/eligible-top-k.test.ts spec/cli.md docs/CLI.md, git diff --check, SQL EXPLAIN and actual rows: notes/fn148.2-sql-evidence.json
- PRs: