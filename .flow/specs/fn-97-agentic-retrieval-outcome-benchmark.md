# fn-97 Agentic Retrieval Outcome Benchmark

## Goal & Context
<!-- scope: business -->

Prove whether GNO helps an agent find sufficient evidence, cite it, and stop efficiently. Existing evals score retrieval stages; they do not expose bad collection choice, unnecessary tool calls, unsupported final claims, or premature stopping. Build a deterministic end-to-end trajectory benchmark that becomes the promotion gate for Context Capsules and later retrieval changes.

## Architecture & Data Models
<!-- scope: technical -->

Create 20–30 versioned `AgentTask` fixtures under `evals/fixtures/agentic-retrieval/`. Each fixture has an opaque task ID, agent-visible brief, isolated corpus, allowed tools, expected collection/filter behavior, public claim definitions (`claimKey` plus `valueType`), and completion/abstention predicate. A separate hidden oracle contains each claim's expected normalized typed value, normalizer ID/version, required/optional/forbidden exact evidence spans, and expected-missing evidence. Categories cover exact identifiers, ambiguity, multi-document comparison, meetings/decisions, temporal questions, typed relationships, code/docs, multilingual prose, and missing-evidence abstention.

Evidence coordinates are exact and portable: corpus-relative URI, SHA-256 of the source's exact UTF-8 bytes, and a 1-based inclusive line range. The span hash is SHA-256 over the exact UTF-8 bytes returned for that line range after the fixture loader's one declared newline canonicalization (`CRLF`/`CR` to `LF`, lines joined by `LF`, no synthetic trailing newline). Agent-visible files, filenames, briefs, and adapter metadata never expose the hidden oracle.

The primary outer agent is a deterministic fixture agent with a pinned state machine, prompt, tool schemas, call budget, and stop policy. It consumes only the agent-visible brief and normalized tool results, then emits a structured `FinalEnvelope`: `claims[]` entries contain only `claimKey`, a tagged `value` whose type is one of the public `string|number|boolean|string[]|date|identifier` claim types, and exact evidence `citations`; `gaps[]` contain `claimKey` plus one of `missing_evidence|conflicting_evidence|budget_exhausted|tool_unavailable`; top-level fields contain `abstained` and `stopReason` from `complete|abstained|budget_exhausted|tool_unavailable|error`. Arbitrary answer/prose text is forbidden. Unknown or duplicate claim keys, invalid typed values, extra claims, uncited required claims, unknown enum values, and prose fields deterministically score unsupported/invalid rather than being ignored. An optional cached-local-model lane uses one pinned prompt/model/tokenizer and exactly three paired trials per task and adapter; trial IDs/seeds and task order are shared across adapters. `agent-model.lock.json` pins the exact local model URI, local file SHA-256, tokenizer identifier/checksum, maximum steps, maximum output tokens, and three-trial seed schedule. The lane is opt-in, refuses absent or mismatched lock inputs, requires no network/API key, and reports variance without replacing the deterministic promotion lane.

The runner owns corpus setup, adapter lifecycle, the outer-agent loop, timeout/call budgets, and failure classification. `fixture-db.ts` performs production ingestion/canonicalization once, before either lifecycle cohort, and produces one immutable fingerprinted index snapshot consumed identically by all adapters. Index/corpus preparation is reported separately and never included in cold or warm scores. Pluggable adapters implement product-faithful GNO MCP, lexical-only, eval-only Capsule prototype, and qmd comparison. A normalized `TrajectoryReceipt` separates:

- `canonical`: schemas, task/adapter/trial IDs, normalized calls and arguments, `agentCalls`, `backendInvocations`, returned evidence coordinates/hashes with provenance, model-visible UTF-8 byte counts, token counts when a pinned tokenizer is available, final envelope, stop/failure classification, and corpus/prompt/tool/model/runtime/config fingerprints.
- `observations`: monotonic `preparation`, `startup`, `modelLoad`, `tool`, `driver`, and end-to-end timings, timestamps, process/resource measurements, temp paths, redacted diagnostics, and other volatile values excluded from canonical hashes. Every timing is nullable with an explicit `unavailableReason` when an adapter cannot expose it.

Deterministic scorers compare the structured claims/citations and trajectory against the hidden oracle. Harness failures are never scored as product failures and cannot silently shrink a comparison cohort.

## API Contracts
<!-- scope: technical -->

- `bun run eval:agentic -- [--adapter <id>] [--task <id>] [--lifecycle cold|warm] [--agent fixture|local-model] [--write]` is local and opt-in. The default is the deterministic fixture agent.
- Versioned schemas live at `evals/agentic/schemas/{agent-task,hidden-oracle,trajectory-receipt,final-envelope,benchmark-report}.schema.json`; schema/types stay aligned.
- Fixture layout: `evals/fixtures/agentic-retrieval/{manifest.json,tasks/*.json,oracles/*.json,corpus/<task-id>/**,baseline/**}`. Manifest pins schema versions and hashes every task, oracle, and corpus file.
- `evals/fixtures/agentic-retrieval/agent-model.lock.json` pins exact cached-local-model URI/file/checksums, tokenizer, budgets, and three-trial seed schedule; `evals/fixtures/agentic-retrieval/qmd.lock.json` pins the comparator repository URL, full commit, package name/version, repository-relative entrypoint, tool-schema hashes, and model IDs/checksums.
- `AgentAdapter` declares capabilities and implements `prepare`, `listTools`, `callTool`, `reset`, and `dispose`; tool results use one normalized content/evidence envelope.
- The GNO adapter calls the shipped MCP tools and schemas through an isolated stdio server; it does not import pipeline internals or add hidden retrieval shortcuts.
- The lexical and Capsule-prototype adapters are eval-only. The Capsule prototype selects extractive, non-overlapping exact spans under one global model-visible UTF-8 byte budget; it does not establish the production fn-98 contract.
- The qmd adapter requires `QMD_REPO` to name a dedicated checkout matching every `qmd.lock.json` field, including exact `HEAD` `e428df76bc0274d9e93eb7ca3e95673315c42e90`. Missing path, dirty checkout, repository/package/version/entrypoint mismatch, tool-schema mismatch, model checksum mismatch, unavailable command, or unsupported contract is a fail-closed harness error. It resolves only the locked repository-relative entrypoint, never reads a global/PATH qmd install, and never checks out, pulls, installs, or mutates the supplied repository. Each run supplies isolated `QMD_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` outside the checkout.
- `spec/evals-agentic.md` documents schemas, lifecycle, accounting, comparison cohorts, formulas, reproducibility, qmd setup, and limitations. `spec/evals.md` links to it.

## Edge Cases & Constraints
<!-- scope: technical -->

- Pin fixture-agent version, prompts, tool schemas, corpora, budgets, model/tokenizer identifiers, runtime/config fingerprints, and random seeds where supported.
- Primary context consumption is the sum of exact UTF-8 bytes in all model-visible tool-result payloads, including repeated reads and error payloads. Raw transport/protocol bytes and hidden harness metadata are excluded. Token counts are secondary and only comparable when the same pinned tokenizer is used; otherwise report `null`, never an estimate presented as measured.
- Corpus ingestion/canonicalization and immutable index construction complete before both cold and warm cohorts and are reported only as preparation. A `cold` trial starts a fresh adapter process against the same immutable prebuilt index and locked cached model; its first tool call is scored, with no readiness/warm-up call. Cold end-to-end timing starts before process startup and ends after the final envelope, including startup/model-load/tool/driver time but excluding preparation. A `warm` cohort preserves one adapter process, the same index, and loaded model after exactly one discarded readiness probe; it resets only task-visible agent state between scored trials. Warm end-to-end timing starts at the first scored agent step and ends after the final envelope, excluding preparation/startup/model load/readiness. Receipts split preparation, startup, model-load, tool, driver, and end-to-end timing for every adapter; unavailable components are `null` with a reason. Never compare unlike lifecycle states.
- Separate `harness_error`, `agent_error`, and `product_error`; report every attempted pair and exclusion reason. Timeouts and malformed tool/final envelopes fail closed.
- Opaque IDs and separate oracle files prevent answers leaking through filenames, task metadata, adapter labels, logs visible to the agent, or corpus setup.
- Canonical hashes exclude observations but include every decision-affecting input/output. Two unchanged-input deterministic replays must produce byte-identical canonical JSON after stable key ordering.
- qmd is external, read-only, exact-revision pinned, and optional for ordinary `bun test`; a requested qmd run cannot downgrade or skip itself on preflight failure.
- qmd evidence hashes distinguish `harness_observed` SHA-256 of exact returned content from backend-provided source/span hashes. Backend hashes are nullable with a reason; the hidden oracle is never passed to qmd or used to synthesize adapter hashes.
- Fixture/schema/scorer tests require neither network nor API keys. Cached-local-model and qmd runs remain explicit opt-in lanes.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** At least 20 validated, leak-resistant tasks cover every agreed category; public fixtures declare claim keys/types while separate hidden oracles pin normalized expected values, normalizers, exact line/hash evidence semantics, and abstention expectations. Unknown/invalid/extra/prose output fails deterministically.
- **R2:** One pinned deterministic fixture agent and runner execute identical agent-visible briefs against product-faithful GNO MCP, lexical-only, eval-only Capsule prototype, and fail-closed revision-pinned qmd adapters. The optional cached-local-model lane uses a checksum-verified lock and runs exactly three paired trials.
- **R3:** Receipts separate deterministic canonical data from volatile observations and record normalized calls, distinct agent-call/backend-invocation counts, exact evidence spans/hashes and hash provenance, model-visible UTF-8 bytes, measured tokens when comparable, separated lifecycle timings, structured claims/citations/gaps, stop/failure reason, and reproducibility fingerprints.
- **R4:** Deterministic scoring distinguishes completed, supported, unsupported, missing-required, forbidden, correct-abstention, and premature/unnecessary-read outcomes without an LLM judge; harness failures remain visible and unscored.
- **R5:** Committed baselines contain schema-valid canonical receipts, observations, environment/methodology, known limitations, and cohort/exclusion accounting. Fixture/schema/scorer tests run in `bun test`; `eval:agentic` stays opt-in.
- **R6:** Capsule promotion is evaluated only on the same non-harness-failed task/trial pairs `P` for Capsule and current GNO in the same lifecycle. With `success_a(p) ∈ {0,1}`, outer-agent tool calls `agentCalls_a(p)`, and model-visible UTF-8 bytes `bytes_a(p)`, every pair must satisfy `success_capsule(p) >= success_gno(p)` and the aggregate must satisfy `ΣP success_capsule / |P| >= ΣP success_gno / |P|`. Efficiency gates are `1 - (ΣP agentCalls_capsule / ΣP agentCalls_gno) >= 0.25` and `1 - (ΣP bytes_capsule / ΣP bytes_gno) >= 0.35`, with non-zero GNO denominators or a failed gate. Backend/internal invocations are reported separately as `backendInvocations` and never substituted for `agentCalls`. Across substantive final claims in `P`, `linked_supported_claims_capsule / substantive_claims_capsule >= 0.95`, with a non-zero denominator; abstention-only tasks are scored by their completion predicates and do not fabricate claims. Every fixture-agent Capsule task also produces byte-identical canonical Capsule payload JSON and SHA-256 on two unchanged-input replays. Any missing pair, pairwise or aggregate accuracy loss, threshold miss, denominator failure, or nondeterminism fails promotion rather than being averaged away.

## Boundaries
<!-- scope: business -->

No production ranking change, public leaderboard, hidden user telemetry, representative-workload claim, remote model dependency, global qmd installation/mutation, or production Capsule implementation. The prototype exists only to measure the one-call extractive evidence-bundle hypothesis before `fn-98`.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Adoption and trust depend on agent outcomes, not Recall@K alone. This benchmark supplies reproducible proof and stops future features from optimizing a proxy while agents still read too much or cite too little.

### Implementation Tradeoffs
<!-- scope: technical -->

The deterministic fixture agent is intentionally narrower than a general model, but makes adapter and retrieval regressions reproducible. Three paired cached-model trials add realism and variance evidence without making promotion quota-sensitive. Model-visible UTF-8 bytes are the primary cross-adapter context measure because tokenizer counts are not comparable across unpinned tokenizers.

## Implementation Plan

1. `fn-97-agentic-retrieval-outcome-benchmark.1` — Define fixtures, schemas, receipts, hidden oracles, and deterministic scorers (**L**)
2. `fn-97-agentic-retrieval-outcome-benchmark.2` — Build the pinned outer-agent driver and benchmark runner (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.1`
3. `fn-97-agentic-retrieval-outcome-benchmark.3` — Add product-faithful GNO MCP adapter and instrumentation (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.2`
4. `fn-97-agentic-retrieval-outcome-benchmark.4` — Add lexical comparator and eval-only Capsule prototype (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.2`
5. `fn-97-agentic-retrieval-outcome-benchmark.5` — Add fail-closed revision-pinned qmd comparator (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.2`
6. `fn-97-agentic-retrieval-outcome-benchmark.6` — Register adapters, publish baselines/reports, and enforce promotion gates (**M**); depends on `fn-97-agentic-retrieval-outcome-benchmark.3`, `fn-97-agentic-retrieval-outcome-benchmark.4`, `fn-97-agentic-retrieval-outcome-benchmark.5`

## Quick commands

```bash
bun test test/eval/agentic
bun run eval:agentic -- --agent fixture --adapter gno-mcp,lexical,capsule --lifecycle cold --write
QMD_REPO=/Users/gordon/repos/qmd-e428df76 bun run eval:agentic -- --agent fixture --adapter qmd --lifecycle cold --write
.flow/bin/flowctl validate --spec fn-97-agentic-retrieval-outcome-benchmark --json
```

## References

- [SGR-Bench](https://arxiv.org/abs/2605.22219) — agentic search behavior.
- [AgenticRAGTracer](https://arxiv.org/abs/2602.19127) — trajectory diagnostics.
- [OpenAI evaluation guidance](https://openai.com/index/trustworthy-third-party-evaluations-foundations/).
- `evals/helpers/setup-db.ts` — isolated fixture DB pattern.
- `src/mcp/server.ts` and `src/mcp/tools/` — shipped MCP boundary.
- qmd revision `e428df76bc0274d9e93eb7ca3e95673315c42e90` — immutable external comparator.

## Early proof point

Task `fn-97-agentic-retrieval-outcome-benchmark.1` validates that leak-resistant tasks, exact evidence coordinates, canonical receipts, and deterministic scorers can distinguish sufficient evidence and correct stopping without an LLM judge. If it fails, revisit the fixture/oracle split and scoring semantics before building the driver or adapters.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Validated tasks, separate hidden oracles, leak prevention, and exact line/hash evidence semantics. | fn-97-agentic-retrieval-outcome-benchmark.1 | — |
| R2 | Same pinned driver across GNO, lexical, Capsule prototype, and qmd; optional three-trial local-model lane. | fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.3, fn-97-agentic-retrieval-outcome-benchmark.4, fn-97-agentic-retrieval-outcome-benchmark.5, fn-97-agentic-retrieval-outcome-benchmark.6 | — |
| R3 | Canonical/observation receipts, exact trajectory/evidence/accounting/lifecycle data, and fingerprints. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.3, fn-97-agentic-retrieval-outcome-benchmark.4, fn-97-agentic-retrieval-outcome-benchmark.5, fn-97-agentic-retrieval-outcome-benchmark.6 | — |
| R4 | Deterministic claim/evidence/stop scoring and explicit harness-failure separation. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.6 | — |
| R5 | Schema-valid committed baselines, methodology/limitations, and standard-test coverage. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.3, fn-97-agentic-retrieval-outcome-benchmark.4, fn-97-agentic-retrieval-outcome-benchmark.5, fn-97-agentic-retrieval-outcome-benchmark.6 | — |
| R6 | Pairwise and aggregate success, agent-call/context formulas, claim linkage, and unchanged-input Capsule determinism. | fn-97-agentic-retrieval-outcome-benchmark.1, fn-97-agentic-retrieval-outcome-benchmark.2, fn-97-agentic-retrieval-outcome-benchmark.4, fn-97-agentic-retrieval-outcome-benchmark.6 | — |
