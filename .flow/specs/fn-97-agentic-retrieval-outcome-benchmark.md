# fn-97 Agentic Retrieval Outcome Benchmark

## Goal & Context
<!-- scope: business -->

Prove whether GNO helps an agent find sufficient evidence, cite it, and stop efficiently. Existing evals score retrieval stages; they do not expose bad collection choice, unnecessary tool calls, unsupported final claims, or premature stopping. Build a deterministic end-to-end trajectory benchmark that becomes the promotion gate for Context Capsules and later retrieval changes.

## Architecture & Data Models
<!-- scope: technical -->

Define 20–30 versioned `AgentTask` fixtures spanning exact identifiers, ambiguity, multi-document comparison, decisions/meetings, temporal questions, typed relationships, code/docs, multilingual prose, and missing-evidence abstention. Each task declares corpus snapshot, allowed tools, required/forbidden evidence spans, expected collection/filter behavior, and completion predicates.

A runner executes the same pinned outer agent/model against pluggable adapters: current GNO skill/MCP workflow, the `fn-98` Capsule adapter, current qmd, and lexical-only baseline where meaningful. Capture a normalized `TrajectoryReceipt`: calls/arguments, returned URIs/spans/hashes, bytes/tokens read, timing, final claims/citations, stop reason, runtime/model/config fingerprints, and redacted errors.

Use deterministic validators for evidence and citation coverage. Optional model judging may score prose quality but cannot decide the promotion gate alone.

## API Contracts
<!-- scope: technical -->

- Local opt-in `bun run eval:agentic` with adapter/task filters and JSON/Markdown output.
- Versioned fixture and receipt schemas under `evals/`; no global GNO config or production DB mutation.
- Adapter interface supports tool listing/calls, reset, warm/cold mode, and capability declaration.
- Result comparison reports accuracy, evidence coverage, unsupported claims, calls, context bytes/tokens, time-to-sufficient-evidence, and stop quality.

## Edge Cases & Constraints
<!-- scope: technical -->

- Pin model, prompts, tool schemas, corpus hashes, and random seeds where supported.
- Separate harness failures from agent/product failures.
- Prevent fixture answers from leaking through filenames, task metadata exposed to the agent, or adapter labels.
- Run warm and cold latency separately; never compare unlike lifecycle states.
- qmd remains an external read-only comparison and must be revision-pinned.
- No network/API-key requirement for fixture/schema validation in the standard test suite.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** At least 20 deterministic tasks cover every agreed retrieval/agent category, including abstention and multilingual cases.
- **R2:** The runner executes identical task briefs against current GNO and at least one non-GNO/lexical comparator through normalized adapters.
- **R3:** Receipts record exact evidence spans/hashes, calls, bytes/tokens, timing, claims/citations, stop reason, and reproducibility fingerprints.
- **R4:** Deterministic scoring distinguishes supported, unsupported, missing, and forbidden evidence without relying on an LLM judge.
- **R5:** Baseline artifacts are committed with documented environment and known limitations; fixture/schema tests run in `bun test`.
- **R6:** The Capsule promotion gate is encoded: no completed-task accuracy loss, at least 25% fewer retrieval calls, at least 35% less context consumed, at least 95% substantive-claim evidence linkage, and deterministic unchanged-input payloads.

## Boundaries
<!-- scope: business -->

No production ranking change, no public leaderboard, no hidden user telemetry, no claim that the fixture represents every agent workload, and no Capsule implementation beyond the adapter contract consumed by `fn-98`.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Adoption and trust depend on agent outcomes, not Recall@K alone. This benchmark supplies reproducible proof and stops future features from optimizing a proxy while agents still read too much or cite too little.

### Implementation Tradeoffs
<!-- scope: technical -->

Deterministic span validation is narrower than open-ended judging but makes regressions actionable. Keeping generation-backed runs opt-in avoids turning the standard gate into a slow, quota-sensitive suite.

## Implementation Plan

1. `fn-97-agentic-retrieval-outcome-benchmark.1` — Define agent tasks trajectory receipts and deterministic scorers (**M**)
2. `fn-97-agentic-retrieval-outcome-benchmark.2` — Instrument the current GNO agent workflow adapter (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.1`
3. `fn-97-agentic-retrieval-outcome-benchmark.3` — Add comparator and Capsule-prototype adapters (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.1`
4. `fn-97-agentic-retrieval-outcome-benchmark.4` — Publish baselines and enforce Capsule promotion gates (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.2`, `fn-97-agentic-retrieval-outcome-benchmark.3`

## Quick commands

```bash
bun test test/evals/agentic*
bun run eval:agentic -- --write
.flow/bin/flowctl validate --spec fn-97-agentic-retrieval-outcome-benchmark --json
```

## References

- [SGR-Bench](https://arxiv.org/abs/2605.22219) — agentic search behavior.
- [AgenticRAGTracer](https://arxiv.org/abs/2602.19127) — trajectory diagnostics.
- [OpenAI evaluation guidance](https://openai.com/index/trustworthy-third-party-evaluations-foundations/).
- `evals/helpers/setup-db.ts` — isolated fixture DB pattern.

## Early proof point

Task `fn-97-agentic-retrieval-outcome-benchmark.1` validates the core approach (a frozen task/receipt/scorer contract can distinguish sufficient evidence and correct stopping without an LLM judge).
If it fails, re-evaluate the task taxonomy, evidence qrels, and trajectory normalization contract before continuing with `fn-97-agentic-retrieval-outcome-benchmark.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | At least 20 deterministic tasks cover every agreed retrieval/agent category, including abstention and multilingual cases. | fn-97-agentic-retrieval-outcome-benchmark.1 | — |
| R2 | The runner executes identical task briefs against current GNO and at least one non-GNO/lexical comparator through normalized adapters. | fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.3 | — |
| R3 | Receipts record exact evidence spans/hashes, calls, bytes/tokens, timing, claims/citations, stop reason, and reproducibility fingerprints. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.3, fn-97-agentic-retrieval-outcome-benchmark.4 | — |
| R4 | Deterministic scoring distinguishes supported, unsupported, missing, and forbidden evidence without relying on an LLM judge. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.4 | — |
| R5 | Baseline artifacts are committed with documented environment and known limitations; fixture/schema tests run in `bun test`. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.4 | — |
| R6 | The Capsule promotion gate is encoded: no completed-task accuracy loss, at least 25% fewer retrieval calls, at least 35% less context consumed, at least 95% substantive-claim evidence linkage, and deterministic unchanged-input payloads. | fn-97-agentic-retrieval-outcome-benchmark.3, fn-97-agentic-retrieval-outcome-benchmark.4 | — |
