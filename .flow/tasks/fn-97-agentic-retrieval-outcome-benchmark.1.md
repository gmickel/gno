---
satisfies: [R1, R3, R4, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.1 Define agent tasks trajectory receipts and deterministic scorers

## Description
Deliver define agent tasks trajectory receipts and deterministic scorers as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic/types.ts`, `evals/fixtures/agentic-retrieval`, `evals/agentic/scoring.ts`, `test/evals/agentic-contract.test.ts`, `spec/evals.md`

### Approach
- Freeze 20-30 task briefs, corpora, allowed tools, required/forbidden spans, filters, and stop/abstention expectations across every agreed category.
- Define one versioned receipt/fingerprint lineage reused by fn-98/100/101/104/108, separating canonical payload from volatile timing.
- Score evidence coverage, supported/unsupported/missing/forbidden claims, filter choice, and stop quality deterministically; reserve LLM judging for optional prose analysis.

### Investigation targets
**Required** (read before coding):
- `evals/helpers/setup-db.ts`
- `src/bench/types.ts:51-94`
- `evals/fixtures/hybrid-adversarial.json`
- `spec/evals.md`

**Optional** (reference as needed):
- `evals/ask.eval.ts`
- `evals/query.eval.ts`

### Key context
- Pinned tool schema, prompt, corpus, budgets, models, and tokenizer/accounting method belong in every run fingerprint.
- If a stochastic outer model is used, the gate requires repeated runs and a declared variance rule; offline fixture-agent scoring remains deterministic.

## Acceptance
- [ ] At least 20 validated tasks cover identifiers, ambiguity, comparison, meetings/decisions, temporal, graph, code/docs, multilingual, and abstention.
- [ ] Receipts capture exact spans/hashes, normalized calls/arguments/order, bytes/tokens, timing, claims/citations, and stop reason.
- [ ] Deterministic scorers correctly distinguish all evidence classes without an LLM judge.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
