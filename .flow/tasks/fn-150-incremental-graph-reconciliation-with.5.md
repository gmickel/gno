---
satisfies: [R4, R5]
---
# fn-150-incremental-graph-reconciliation-with.5 Drive graph consumers and verify scoped scaling

## Description
Drive graph consumers and verify scoped scaling. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/API.md, docs/MCP.md, docs/WEB-UI.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-150-incremental-graph-reconciliation-with/
**Touches:** [docs/API.md, docs/MCP.md, docs/WEB-UI.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-150-incremental-graph-reconciliation-with/]

### Approach

- Run real backlinks/graph/impact consumers after each mutation against full oracle; include outside-view degree/visibility and inactive restored documents.
- Measure no-op/narrow/broad sync over101/1001/5001documents with content reads and real SQL mutation counters; report timing as synthetic, not attribution of private vault elapsed time.
- Reconcile invalidation/rebuild guidance, complete repo gates and drive changed graph UI/hosted pages. Keep graph-response computation/cache work outside this scope.

### Investigation targets

**Required:**
- `test/core/graph-query.test.ts`
- `test/core/graph-analysis.test.ts`
- `test/serve/routes/graph-query.test.ts`
- `docs/API.md:1908`
- `docs/WEB-UI.md:693`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/core/graph-query.test.ts test/core/graph-analysis.test.ts test/serve/routes/graph-query.test.ts
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Public consumers return oracle-equal supported diagnostics/edges without domain leakage.
- [ ] Fault recovery observed through actual sync, not only store mocks.
- [ ] Full gates and changed-page QA pass; results preserve corpus/runtime identities and raw counters.

## Done summary
Task fn150.5 acceptance is complete within the authorized scope; Flow remains
in_progress until the host records completion. Final public graph consumers are oracle-equal across
all ten mutations at checkpoint 635293b6; the original dd38f777 rename REST
backlinks failure is preserved alongside its shared document-ID lookup fix.

Evidence index: `.flow/artifacts/fn-150-incremental-graph-reconciliation-with/README.md`.
Raw initial/post-fix CLI, REST and MCP responses, scoped visibility checks,
101/1001/5001 actual-sync read/DML counters, fixture identities, task4 crash
provenance and desktop/mobile browser captures are under that directory.

Committed by host: src/store/sqlite/adapter.ts; new
test/store/docid-active-owner.test.ts; test/store/adapter.test.ts;
docs/API.md; docs/MCP.md; docs/WEB-UI.md. The adapter change prefers active
same-docid rows deterministically while preserving inactive-only lookup. Three
adapter-test schema expectations now follow the latest migration. Documentation
covers graph invalidation/rebuild and the coordinated fn147 restoration contract.

Validation: original graph baseline 17 tests/167 assertions; new regression red
against frozen dd38f777 and green after fix; final focused adapter/REST suite
60 tests/1180 assertions; typed lint/format pass; docs verification 15 pass,
two skips. Actual post-fix public runner exits 0 with all 150 paired captures
equal. No-op sync has zero content reads and zero edge mutations at all sizes;
single-target change has two content reads and only required dependent deletes.
Broad 5001-document source mutation takes 27.36 seconds; synthetic single sample,
no private-vault performance attribution.

Evidence is committed in 9d6c73a9; the source fix is committed in 635293b6.
Host integrated gates are green: bun test 5,132 pass, two existing skips,
zero failures, 41,089 assertions across 601 files (276.17 seconds). Lint has
zero errors and 23 existing warnings; formatting, typecheck, docs, package smoke,
memory and separate lexical evals pass. Exact logs and hashes are recorded in
integrated-gates.json. No tests were rerun for this evidence-only finalization.

Scoped QA verdict is YES/SHIP: no open P0/P1 and R4/R5 coverage complete.
Known P2 graph-header overflow remains reproduced at mobile 390×844, matching
the existing fn151/fn152 finding. No duplicate issue or unrelated UI fix. All
owned browser/server processes stopped. No native/GPU work or model downloads.
The P2 remains tracked and is non-blocking under QA workflow6.1; no severity
was changed to obtain acceptance. Hosted gno.sh documentation and site QA are
explicitly deferred by the user until after the aggregate PR, with no hosted
mutations. No remaining fn150 acceptance work at this checkpoint.

stage: impl-review - skipped(config: no formal reviews; host owns acceptance)
## Evidence
- Commits: 635293b6c309cf3be34facf30b4fbc1802167cae, 9d6c73a9
- Tests: Frozen baseline: bun test ./test/core/graph-query.test.ts ./test/core/graph-analysis.test.ts ./test/serve/routes/graph-query.test.ts — 17 pass, 167 assertions, Frozen dd38f777 new regression: bun test ./test/store/docid-active-owner.test.ts — expected failure selecting inactive owner, TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-qa bun test ./test/store/docid-active-owner.test.ts ./test/store/adapter.test.ts ./test/serve/routes/links.test.ts — 60 pass, 1180 assertions, bunx oxlint --type-aware --type-check src/store/sqlite/adapter.ts test/store/docid-active-owner.test.ts test/store/adapter.test.ts — pass (two recorded invocations), bunx oxfmt changed source/tests/docs — pass, bun run docs:verify — 15 pass, 0 fail, 2 skipped, Frozen635293b6 public-consumers.ts — exit0; 10 mutations x15 CLI/REST/MCP captures oracle-equal, Frozen dd38f777 scaling.ts — exit0;101/1001/5001 actual sync with raw content-read and SQL edge-mutation counters, agent-browser fn150-graph-qa desktop/mobile — graph renders, collection selector driven; existing mobile overflow P2 reproduced twice, Host integrated gate: bun test — 5132 pass,2 existing skips,0 fail,41089 assertions,601 files,276.17s, Host integrated gate: bun run lint:check — 0 errors,23 existing warnings; formatting passes, Host integrated gate: bun run typecheck — pass, Host integrated gate: bun run docs:verify — 15 pass,0 fail,2 skips, Host integrated gate: bun scripts/package-smoke.ts — pass; sentinel unchanged, Host integrated gate: bun --bun evalite evals/memory.eval.ts --threshold 100 (external frozen source) — 100%,19 evals,1 file,threshold100 passed; memory-selected.log authoritative, memory.log archived-copy discovery diagnostic only, Host integrated gate: separate hybrid and vsearch lexical eval invocations — hybrid86%,vsearch88%,threshold70 passed; initial combined lexical.log command rejected argument count and was superseded
- PRs: