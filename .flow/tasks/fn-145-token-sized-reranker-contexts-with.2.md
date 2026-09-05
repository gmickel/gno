---
satisfies: [R1, R4]
---
# fn-145-token-sized-reranker-contexts-with.2 Use sized contexts with safe growth and shrink

## Description
Use sized contexts with safe growth and shrink. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/nodeLlamaCpp/rerank.ts, src/llm/nodeLlamaCpp/rerank-capacity.ts (new), test/llm/node-rerank-context-size.test.ts (new), docs/HOW-SEARCH-WORKS.md, docs/ARCHITECTURE.md
**Touches:** [src/llm/nodeLlamaCpp/rerank.ts, src/llm/nodeLlamaCpp/rerank-capacity.ts, test/llm/node-rerank-context-size.test.ts, docs/HOW-SEARCH-WORKS.md, docs/ARCHITECTURE.md]

### Approach

- Choose one compatible context for the current model-generation/configuration/capacity bucket; replace only when idle when bucket changes, including shrink after large requests.
- Do not build a second worker owner. If fn-144 is already integrated, execute inside its native child; otherwise keep the sizing port compatible for that integration.
- Preserve all candidate indices, duplicate score mapping and ties; fail/fallback explicitly at capacity boundaries. Couple resource-policy prose to the code change.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/rerank.ts:64`
- `src/llm/nodeLlamaCpp/lifecycle.ts`
- `src/pipeline/rerank.ts:108`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/node-rerank-context-size.test.ts test/pipeline/rerank-normalization.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Short→long→short test releases oversized context and retains identical scores and ordering.
- [ ] Concurrent different sizes, model expiry and failure cannot use disposed contexts or omit candidates.
- [ ] No allocation on empty list; no silent extra truncation for unsupported/over-limit input.

## Done summary
# fn-145.2 — implementation ready for host integration

Status: in_progress; host owns Flow, Git, full gates and physical QA. No commits,
formal reviews, native model allocation, GPU workload or shared lifecycle edits.

Implemented one retained native ranking context per port, keyed by loaded model
object, formatter/model configuration and capacity bucket. Uses the fn-145.1
complete-pair oracle unchanged. Serial batch admission makes growth and shrink
idle-only; accepted batches drain before port disposal. Model leases cover loading,
replacement, scoring and explicit context cleanup. Input arrays are snapshotted
before queueing. Existing duplicate-index mapping, native scores and tie order are
preserved; missing/invalid scores fail as structured INFERENCE_FAILED results.
Unknown formatter contracts retain native auto sizing without extra clipping;
known over-model-limit inputs fail before allocation. Failed contexts are discarded.

Files changed:
- src/llm/nodeLlamaCpp/rerank.ts
- test/llm/node-rerank-context-size.test.ts
- docs/HOW-SEARCH-WORKS.md
- docs/ARCHITECTURE.md

Six focused tests cover R1/R4: short-long-short with reuse/duplicates/ties;
concurrent different capacities and draining disposal; expired model replacement;
creation/scoring/incomplete-result recovery; empty batches and unsupported/config
changes; and over-model-limit structured failure. Existing formatter and pipeline
normalization tests pass without changing fixed fixture bytes or golden outputs.

Baseline: green, 17 existing tests; new task test did not exist before editing.
Final: 23 pass, 0 fail. Targeted type-aware/type-check Oxlint and Oxfmt green.
Logs: /home/gordon/.cache/agent-tmp/gno-fn145-context/{baseline,focused,lint,format}.log.

Coordination: host notified that ModelManager must remove retiring models from
its cache before awaiting disposal, preventing load/lease admission from returning
an already-retiring generation. This task does not edit lifecycle.ts. Disposed
model/context guards fail closed, but disposal-in-flight ownership belongs to
fn-144's lifecycle owner. No new worker owner or public configuration added.

Native score/allocation parity and CUDA/physical Metal measurements remain for
fn-145.3/.4 and host QA. The deterministic stubs establish ownership and complete
input transport, not physical memory improvements. Downstream gno.sh docs remain
queued by the user until after aggregate PR.

stage: impl-review - skipped(config: user disabled formal reviews)
## Evidence
- Commits: df9ffe64a89bcae3fdd13701d0914dd3b3a8c2c3
- Tests: baseline: green — bun test ./test/llm/node-rerank-format.test.ts ./test/pipeline/rerank-normalization.test.ts (17 pass), bun test ./test/llm/node-rerank-context-size.test.ts ./test/llm/node-rerank-format.test.ts ./test/pipeline/rerank-normalization.test.ts (23 pass), bunx oxlint --type-aware --type-check src/llm/nodeLlamaCpp/rerank.ts src/llm/nodeLlamaCpp/rerank-capacity.ts test/llm/node-rerank-context-size.test.ts (exit 0), bunx oxfmt --check src/llm/nodeLlamaCpp/rerank.ts src/llm/nodeLlamaCpp/rerank-capacity.ts test/llm/node-rerank-context-size.test.ts docs/HOW-SEARCH-WORKS.md docs/ARCHITECTURE.md (exit 0)
- PRs: