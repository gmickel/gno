---
satisfies: [R2, R3, R4]
---
# fn-97-agentic-retrieval-outcome-benchmark.2 Build the pinned outer-agent driver and benchmark runner

## Description
Build one adapter-neutral agent loop and runner so every system receives the same visible task and stopping policy.

**Size:** M
**Files:** `evals/agentic/fixture-agent.ts`, `evals/agentic/local-model-agent.ts`, `evals/agentic/runner.ts`, `evals/agentic/adapter.ts`, `evals/fixtures/agentic-retrieval/agent-model.lock.json`, `test/eval/agentic/driver.test.ts`, `test/eval/agentic/runner.test.ts`, `test/eval/agentic/agent-model-lock.test.ts`

### Approach
- Implement the deterministic fixture agent as the standard lane: pinned state machine/prompt/tool schema/call budget/stop policy, normalized tool results only, and prose-free schema-valid typed claims/citations/gaps.
- Add an opt-in cached-local-model lane whose `agent-model.lock.json` contains an exact model URI, local file SHA-256, tokenizer identifier/checksum, maximum steps/tokens, and three-trial seed schedule. Refuse missing files, checksum/version mismatch, placeholder locks, downloads, API keys, and network fallback.
- Consume task 1's immutable corpus snapshot and coordinate adapter-native index builds during unmeasured preparation. Record corpus and per-adapter index fingerprints/build observations. For each adapter, cold and warm reuse its identical prebuilt native index; cold uses a fresh process and first scored call, while warm uses one process/index after a discarded readiness probe.
- Implement timeout/call budgets, normalized trajectory capture, distinct outer-agent `agentCalls` and internal `backendInvocations`, stable canonical serialization, nullable separated preparation/startup/model/tool/driver/e2e observations, and explicit `harness_error|agent_error|product_error` classification.
- Meter exact model-visible UTF-8 tool-result bytes as primary context. Record tokens only from the same pinned tokenizer; otherwise `null`.

### Investigation targets
**Required** (read before coding):
- Planned task 1 outputs: `evals/agentic/types.ts`, `evals/agentic/schemas/`, `evals/agentic/scoring.ts`
- `evals/helpers/setup-db.ts`
- `evals/helpers/hybrid-benchmark.ts`
- `src/llm/` local model lifecycle patterns

## Acceptance
- [ ] Fixture-agent runs are byte-reproducible from unchanged inputs and emit only schema-valid prose-free typed claims/citations/gaps.
- [ ] The runner uses the same agent-visible brief, driver, budgets, and normalized tool envelope for all adapters.
- [ ] Optional local-model mode preflights every lock field, refuses absent/mismatched/unpinned inputs, and produces exactly three explicitly paired trials per task/adapter using the locked seed schedule.
- [ ] Receipts classify all attempted trials, never score harness failures as product failures, and preserve canonical/observation separation.
- [ ] Receipts distinguish `agentCalls` from `backendInvocations` and split preparation/startup/model/tool/driver/e2e timings; unavailable timing components are null with reasons.
- [ ] UTF-8 model-visible bytes are exact and tokens are measured only with one pinned tokenizer or reported `null`.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
