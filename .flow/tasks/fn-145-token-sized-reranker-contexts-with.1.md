---
satisfies: [R1, R2]
---
# fn-145-token-sized-reranker-contexts-with.1 Pin native rerank formatting and capacity oracle

## Description
Pin native rerank formatting and capacity oracle. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/nodeLlamaCpp/rerank-capacity.ts (new), test/llm/node-rerank-format.test.ts (new), evals/fixtures/acceptance/rerank-long-input/
**Touches:** [src/llm/nodeLlamaCpp/rerank-capacity.ts, test/llm/node-rerank-format.test.ts, evals/fixtures/acceptance/rerank-long-input/]

### Approach

- Isolate compatibility with installed node-llama-cpp3.19.1 formatting/tokenization in one adapter. Differentially compare full formatted pairs with pinned native implementation without allocating an auto-sized context just to count tokens.
- Calculate max required tokens across all prepared pairs; include native padding. Start with the audited256-token padding/256 rounding only after differential boundary tests confirm native safety; otherwise retain safe auto for that unsupported case.
- Freeze EN/DE/CJK long-query and45-case matrices with existing prepared text/dedup semantics. Empty candidates return without native allocation.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/rerank.ts:64`
- `node_modules/node-llama-cpp/dist/evaluator/LlamaRankingContext.js:47`
- `node_modules/node-llama-cpp/dist/evaluator/LlamaRankingContext.js:100`
- `test/pipeline/rerank-normalization.test.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/node-rerank-format.test.ts test/pipeline/rerank-normalization.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Known formatter preserves special tokens and query/template accounting; unknown model/template/version routes to safe auto.
- [ ] Cases above2048 and6025-token query remain complete; over-model-limit errors never shorten extra evidence.
- [ ] Dependency upgrade causes a visible compatibility test failure or fallback rather than a silent guessed format.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
