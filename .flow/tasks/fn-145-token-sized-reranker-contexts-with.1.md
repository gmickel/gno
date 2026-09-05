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
# fn-145.1 — implementation ready for host integration

Status: in_progress; host owns Flow, Git and QA. No commit, lifecycle mutation,
formal review, native model allocation or GPU workload performed by this worker.

Implemented `src/llm/nodeLlamaCpp/rerank-capacity.ts`: pinned 3.19.1 Qwen3 BPE
formatter contract, max complete-pair token counting, audited 256-token margin
and 256 rounding. Unknown version/model/template or invalid model limit returns
auto. Known over-model input raises RangeError; padded capacity beyond the model
maximum returns auto. Empty documents require no model access. No truncation,
deduplication or ranking changes. The module is not yet wired into rerank.ts.

Six focused tests in `test/llm/node-rerank-format.test.ts` compare exact token
streams against the installed native formatter without constructing a context,
including full original/prepared fixture text, special-token modes, native EOS
prepend behavior, capacity boundaries, unsupported contracts and over-limit input.
Differential tokenizer is deterministic: this is formatter compatibility, not a
fresh GGUF tokenizer/score/allocation claim.

Frozen `evals/fixtures/acceptance/rerank-long-input/` includes all 45 historical
EN/DE/CJK cells, historical 69 paired runs, full original/prepared texts, token
matrix and reconstructed exact long-query pair. JSON whitespace normalized to
pass Oxfmt; JSON value equality with source artifacts was checked. Manifest pins
are new, independent of fn-143. 6025 is the full formatted long-query pair count,
not query-only tokens. The audit did not score that long-query pair. README states
provenance and limitations.

Baseline: green, existing normalization suite (11 tests); new test path did not
exist. Final focused suite: 17 pass / 0 fail. Targeted Oxlint type-aware/type-check
and Oxfmt both green. Logs: /home/gordon/.cache/agent-tmp/gno-fn145-oracle/.
Full repo gates and native CUDA/physical Metal QA remain host-owned. No user-facing
runtime behavior changes yet; fixture README documents the internal contract.

stage: impl-review - skipped(config: user disabled formal reviews)
## Evidence
- Commits: 438042bb055d8677464ff84e77db50d5404725e6
- Tests: baseline: green: bun test ./test/pipeline/rerank-normalization.test.ts, PASS (17): bun test ./test/llm/node-rerank-format.test.ts ./test/pipeline/rerank-normalization.test.ts, PASS: bunx oxlint --type-aware --type-check src/llm/nodeLlamaCpp/rerank-capacity.ts test/llm/node-rerank-format.test.ts, PASS: bunx oxfmt --check src/llm/nodeLlamaCpp/rerank-capacity.ts test/llm/node-rerank-format.test.ts evals/fixtures/acceptance/rerank-long-input, PASS: JSON value equality of normalized fixtures/token-matrix/results against original 2026-09-04 audit
- PRs: