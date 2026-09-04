---
satisfies: [R2, R4, R5]
---
# fn-145-token-sized-reranker-contexts-with.3 Integrate score parity and context lifecycle scenarios

## Description
Integrate score parity and context lifecycle scenarios. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/rerank-scenarios.ts (new), test/llm/node-rerank-parity.test.ts (new), evals/fixtures/acceptance/rerank-long-input/
**Touches:** [evals/acceptance/rerank-scenarios.ts, test/llm/node-rerank-parity.test.ts, evals/fixtures/acceptance/rerank-long-input/]

### Approach

- Replay frozen45cells and69paired runs using unchanged models/candidate preparation. Compare122scores, orderings and actual formatted inputs through fn-143 records.
- Add long-query, unsupported-template, ties, growing/shrinking and restart cases; distinguish oversized custom chunks from normal ingestion.
- Preserve all slower pairs and identify shape/order effects; no baseline refresh solely to pass a failing comparison.

### Investigation targets

**Required:**
- `src/pipeline/rerank.ts`
- `evals/acceptance/runner.ts (from fn-143)`
- `test/pipeline/hybrid-intent.test.ts`
- `test/pipeline/rerank-normalization.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/node-rerank-parity.test.ts test/pipeline/hybrid-intent.test.ts
bun run eval:hybrid
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Exact deterministic input/score/rank parity holds on declared equality cases; negative truncated-input control is detected.
- [ ] Real hybrid/Ask paths preserve retrieved spans and citations after context resize/reload.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
