---
satisfies: [R2, R3, R4]
---
# fn-97-agentic-retrieval-outcome-benchmark.2 Build the pinned outer-agent driver and benchmark runner

## Description
Build one adapter-neutral agent loop and runner so every system receives the same visible task and stopping policy.

**Size:** M
**Files:** `evals/agentic/fixture-agent.ts`, `evals/agentic/local-model-agent.ts`, `evals/agentic/runner.ts`, `evals/agentic/adapter.ts`, `test/evals/agentic/driver.test.ts`, `test/evals/agentic/runner.test.ts`

### Approach
- Implement the deterministic fixture agent as the standard lane: pinned state machine/prompt/tool schema/call budget/stop policy, normalized tool results only, and schema-valid `FinalEnvelope` output.
- Add an opt-in cached-local-model lane with a pinned local model/prompt/tokenizer and exactly three paired trials sharing trial IDs/seeds/task order across adapters. No downloads, API keys, or network fallback.
- Implement isolated corpus setup, adapter lifecycle, timeout/call budgets, normalized trajectory capture, stable canonical serialization, observations, and explicit `harness_error|agent_error|product_error` classification.
- Meter exact model-visible UTF-8 tool-result bytes as primary context. Record tokens only from the same pinned tokenizer; otherwise `null`.

### Investigation targets
**Required** (read before coding):
- Planned task 1 outputs: `evals/agentic/types.ts`, `evals/agentic/schemas/`, `evals/agentic/scoring.ts`
- `evals/helpers/setup-db.ts`
- `evals/helpers/hybrid-benchmark.ts`
- `src/llm/` local model lifecycle patterns

## Acceptance
- [ ] Fixture-agent runs are byte-reproducible from unchanged inputs and emit only schema-valid structured final envelopes.
- [ ] The runner uses the same agent-visible brief, driver, budgets, and normalized tool envelope for all adapters.
- [ ] Optional local-model mode refuses uncached/unpinned models and produces exactly three explicitly paired trials per task/adapter.
- [ ] Receipts classify all attempted trials, never score harness failures as product failures, and preserve canonical/observation separation.
- [ ] UTF-8 model-visible bytes are exact and tokens are measured only with one pinned tokenizer or reported `null`.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
