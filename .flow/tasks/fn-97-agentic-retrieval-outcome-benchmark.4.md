---
satisfies: [R2, R3, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.4 Add lexical comparator and eval-only Capsule prototype

## Description
Add bounded in-repo comparators that isolate lexical retrieval and test the one-call Capsule hypothesis without creating production fn-98 surfaces.

**Size:** M
**Files:** `evals/agentic/adapters/lexical.ts`, `evals/agentic/adapters/capsule-prototype.ts`, `evals/agentic/capsule-selection.ts`, `test/eval/agentic/lexical-adapter.test.ts`, `test/eval/agentic/capsule-prototype.test.ts`

### Approach
- Implement a lexical-only adapter on the isolated fixture DB using the production lexical path while disabling model-backed expansion/vector/reranking. Declare unsupported capabilities instead of fabricating parity.
- Implement an eval-only Capsule prototype that retrieves extractive candidates, collapses duplicate/overlapping spans, and selects exact evidence under one global model-visible UTF-8 byte budget.
- Emit canonical Capsule payload JSON containing exact URI/line/hash evidence and deterministic omission reasons; exclude observations and production API/schema commitments.
- Count only outer-agent adapter calls as `agentCalls`; report retrieval/search/selection work separately as `backendInvocations`, never using the latter in R6's call-reduction gate.
- Verify two unchanged-input fixture-agent replays produce byte-identical canonical Capsule JSON and SHA-256.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts`
- `src/pipeline/hybrid.ts`
- `src/bench/fixture.ts`
- Planned task 2 outputs: `evals/agentic/adapter.ts`, `evals/agentic/runner.ts`

**Optional** (reference as needed):
- `evals/helpers/retrieval-candidate-benchmark.ts`
- `src/pipeline/section-addressing.ts`

## Acceptance
- [ ] Lexical receipts disclose disabled/unsupported capabilities and use the same driver, task brief, corpus, and accounting contract.
- [ ] Capsule prototype emits only extractive exact spans under one global UTF-8 model-visible byte budget, with overlap deduplication and deterministic omissions.
- [ ] Two unchanged-input replays produce byte-identical canonical Capsule payload JSON and SHA-256 for every deterministic task.
- [ ] Lexical and Capsule receipts expose distinct `agentCalls` and `backendInvocations`; promotion inputs use only paired `agentCalls`.
- [ ] Tests assert the prototype is eval-only and does not create or claim production CLI/MCP/REST/SDK contracts owned by fn-98.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
