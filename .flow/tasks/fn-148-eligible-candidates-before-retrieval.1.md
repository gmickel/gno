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
# fn-148.1 handover

Status: in_progress; host owns Flow, git, integration and QA. No commits or lifecycle mutations performed by worker.

Added internal pre-budget eligibility evaluation in `src/pipeline/filters.ts`. Reuses existing document/tag/date/author/category/exclude evaluation, intersects caller and user collection/mirror/path scope, treats empty mirror allowlists as deny-all, checks active ownership and metadata availability, and selects exact-language chunks only after whole-document exclusion. The helper is deliberately not wired into retrieval yet. Existing recency/project-affinity/full-document/minScore ranking is untouched.

Added independently hash-pinned 201-document fixture and exhaustive lexical/vector proof tests. Explicit expected eligible match is `scope/target.md` / `#fixture-200:1` at limits 1 and 10. Tests reject the global 10× overfetch algorithm; current lexical starvation is a separately named characterization. Task .2 must replace its empty-result characterization assertions with parity to the unchanged exhaustive expectation. Invalid lexical syntax, internal invalid-date semantics, tag/category/author/date/path/scope zero matches, inactive owners, missing/mismatched metadata, failed/rejected tag reads, whole-document exclusion across language chunks, deterministic oracle ties and duplicate owner identities are pinned.

Files:
- src/pipeline/filters.ts
- evals/fixtures/acceptance/eligible-top-k/fixture.ts
- evals/fixtures/acceptance/eligible-top-k/manifest.json
- evals/fixtures/acceptance/eligible-top-k/README.md
- test/store/eligible-top-k.test.ts
- test/pipeline/eligible-top-k.test.ts

Baseline: green, existing `bun test ./test/store/fts-lexical-regression.test.ts` before edits. New deliverable tests did not exist at baseline.

Validation: 37 focused tests pass, 117 assertions. Targeted Oxlint with type-aware/type-check flags passes for the three source/test files; repository lint configuration excludes the eval fixture (even with `--no-ignore`), so no fixture typecheck claim. Oxfmt check passes for all six files. Logs under `/home/gordon/.cache/agent-tmp/gno-fn148-oracle/` (`baseline.log`, `focused.log`, `lint.log`). TMPDIR outside repository avoids changing project-affinity behavior and avoids exhausted /tmp quota.

Limitations: no production eligible-top-K correction claimed. No native embeddings/vector-store execution or GPU use; fn-143 paired-comparator run, public live QA, full project gate, ranking-policy integration and performance coverage remain downstream. Frozen fn-143 fixture files unchanged. Store lexical oracle uses exact existing 1.5/4/1 BM25 weights with no SQL candidate LIMIT; stable vector tie order is an oracle convention, not a new public ranking policy. The contract helper assumes callers already applied managed-memory supersession/scope SQL rules; it does not implement those independently.

stage: impl-review - skipped(policy: user disabled formal reviews; host owns acceptance)
## Evidence
- Commits: cb3421f6954f796599ea372d577d2971215aef8c
- Tests: baseline green: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-oracle timeout 600 bun test ./test/store/fts-lexical-regression.test.ts, PASS 37 tests / 117 assertions: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-oracle timeout 600 bun test ./test/store/eligible-top-k.test.ts ./test/pipeline/eligible-top-k.test.ts ./test/store/fts-lexical-regression.test.ts, PASS: bunx oxlint --type-aware --type-check src/pipeline/filters.ts evals/fixtures/acceptance/eligible-top-k/fixture.ts test/store/eligible-top-k.test.ts test/pipeline/eligible-top-k.test.ts, PASS: bunx oxfmt --check src/pipeline/filters.ts evals/fixtures/acceptance/eligible-top-k/ test/store/eligible-top-k.test.ts test/pipeline/eligible-top-k.test.ts
- PRs: