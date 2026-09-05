---
satisfies: [R1, R2, R4]
---
# fn-150-incremental-graph-reconciliation-with.1 Freeze global graph oracle and mutation invalidation matrix

## Description
Freeze global graph oracle and mutation invalidation matrix. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/fixtures/acceptance/graph-reconciliation/ (new), test/ingestion/graph-reconciliation.test.ts (new), test/store/graph-performance.test.ts
**Touches:** [evals/fixtures/acceptance/graph-reconciliation/, test/ingestion/graph-reconciliation.test.ts, test/store/graph-performance.test.ts]

### Approach

- Promote101/1001/5001-document synthetic fixtures and count actual content reads/edge row mutations.
- Build independent full-rebuild oracle after each add/delete/restore/rename/title/config mutation, including unresolved incoming references and unique↔ambiguous targets.
- Compare normalized edge tuples plus supported unresolved/ambiguity diagnostics and preserved ordering; source disappearance removes outgoing references.

### Investigation targets

**Required:**
- `src/ingestion/sync.ts:1787`
- `src/ingestion/sync.ts:1966`
- `test/ingestion/sync-incremental.test.ts`
- `test/store/graph-performance.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/ingestion/graph-reconciliation.test.ts test/store/graph-performance.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Oracle catches selected-collection-only restriction and old-identity-only invalidation.
- [ ] Unchanged fixture pins current1001reads/2000row-churn reproduction without treating it as desired golden behavior.
- [ ] Scope/active boundaries and cross-collection incoming references are represented.

## Done summary
# fn-150.1 handover

Implemented the separately pinned graph mutation oracle and 101/1001/5001 actual-read/SQL-row-mutation baseline characterizations. Task remains in_progress; host owns Git, Flow and final QA.

Files:
- evals/fixtures/acceptance/graph-reconciliation/fixture.ts
- evals/fixtures/acceptance/graph-reconciliation/oracle.ts
- evals/fixtures/acceptance/graph-reconciliation/manifest.json
- evals/fixtures/acceptance/graph-reconciliation/README.md
- test/ingestion/graph-reconciliation.test.ts
- test/store/graph-performance.test.ts

Baseline: existing ./test/store/graph-performance.test.ts green before edits; new test absent then as expected.

Verification: `TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-oracle timeout 600 bun test ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts` passed 7 tests / 30 assertions. `bunx tsc --noEmit` passed. Focused type-aware Oxlint and Oxfmt checks passed. Evals are excluded by project lint configuration; TypeScript includes the imported fixture helpers.

Actual unchanged scoped sync counts: 101/1001/5001 content reads; 100/1000/5000 DELETEs plus 100/1000/5000 INSERTs; zero UPDATEs. Baseline reproduction only; dependent implementation should retain evidence while replacing the production-path expectation with improved budgets.

The fresh-source rebuild retains relative insertion precedence, since current ambiguous resolution depends on document IDs. No copied numeric IDs or projected edges. All mutation states compare strictly through the fn-143 paired comparator except identical-source restoration: strict success is accepted, otherwise only the five enumerated legacy rejection fields are accepted as negative characterization. Remove that branch after restoration is fixed. New fixture pin covers materialized mutation states and configurations; fn-143 pins untouched.

Selected-collection-only and old-identity-only counterexamples are rejected. Scope and active-source behavior use actual getGraph diagnostics and exact repeat-call ordering. Crash recovery, public CLI/MCP/API QA and final incremental speed gates belong to dependent tasks. No native models, private index, Git, Flow or shared implementation files touched.

stage: impl-review - skipped(config: user disabled formal reviews; host owns acceptance)

Logs: /home/gordon/.cache/agent-tmp/gno-fn150-oracle/{baseline,focused,typecheck,lint,format}.log
## Evidence
- Commits: bdb2aae8c9c776a59a1e72072a26cfd7258be7cb
- Tests: baseline: green - TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-oracle timeout 600 bun test ./test/store/graph-performance.test.ts, PASS: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn150-oracle timeout 600 bun test ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts (7 tests, 30 assertions), PASS: bunx tsc --noEmit, PASS: bunx oxlint --type-aware --type-check ./test/ingestion/graph-reconciliation.test.ts ./test/store/graph-performance.test.ts, PASS: bunx oxfmt --check evals/fixtures/acceptance/graph-reconciliation/ test/ingestion/graph-reconciliation.test.ts test/store/graph-performance.test.ts
- PRs: