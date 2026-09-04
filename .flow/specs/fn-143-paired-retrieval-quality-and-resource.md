# Paired retrieval quality and resource acceptance

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Agentic users need lower resource cost without losing evidence. Establish a reproducible paired acceptance harness before promoting the audit optimizations. Existing memory evaluation passed 100%, but the current hybrid and vsearch evaluations exercised lexical behavior and cannot certify semantic parity. The audit used GNO 1.46.0 at commit be4c0d32835e79d532de3ae700bf78ae358b22ce, synthetic fixtures, real cached embedding/reranking models and physical CUDA/Metal screens. These are baseline observations, not candidate acceptance.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Use existing evaluation infrastructure and fixture conventions. Preserve immutable baseline/candidate manifests, raw per-query results and resource samples. Exercise actual model-backed embedding, reranking, hybrid retrieval and Ask alongside deterministic lexical/memory contracts. Separate fixtures for known bug corrections from equality fixtures; share the harness with each successor without centralizing its implementation.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Keep this a development acceptance surface. Reports identify case, corpus/model/tokenizer/runtime identity, surface, preset, latency state, ordered results, scores, cited spans, errors/fallbacks and measured resources. Missing native dependencies or unavailable hardware yields explicit incomplete coverage, never a passing semantic gate.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Freeze fixture and model hashes, commits, Bun/native dependency versions and presets. Include EN/DE/CJK, long queries, oversized/custom chunks, rare filters, conflicting tails, duplicates, restoration, model expiry, indexing mutations and concurrency. Isolate synthetic state from the real vault. On Apple Silicon report overlapping unified-memory counters separately. Do not infer a leak, energy benefit or BAR1 causality from RSS/framebuffer samples.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Run the existing memory gate at its unchanged 100% threshold and retain established lexical gates; include real-model semantic and verified-answer checks with recorded coverage. Errors: unavailable models, skipped suites and missing physical platform coverage are explicit unmet gates. [paraphrase]
- **R2:** For mechanical changes, compare every deterministic ordered result, score, selected passage, citation/provenance, scope and actual model input exactly. Predeclare intended changed cases for corrected bugs and use an exhaustive oracle there. Errors: any unexplained per-case quality loss fails; no aggregate compensation. [paraphrase]
- **R3:** Measure fresh process, resident model-cold, warm and post-idle queries separately, including repeated and novel requests plus foreground/background overlap. Use repeated paired blocks, retain raw slower runs and report p50/p95/p99 with sample counts. Errors: insufficient or noisy samples are inconclusive, never proof of equivalence. [inferred]
- **R4:** Record memory recovery and the complete next-query cold cost together. A measured cold penalty may be proposed for idle reclamation; protect warm burst reuse and expose unplanned steady-state regressions. Errors: empty successful answers, hidden fallbacks or excluded model-loading time cannot count as speedups. [paraphrase]
- **R5:** Demonstrate the harness rejects deliberate result loss, scope leakage, misleading vector-success state and changed model input, while accepting an unchanged control. Errors: negative controls run only in isolated fixtures and cannot alter production or golden thresholds. [inferred]
- **R6:** Provide real CLI/MCP/API QA evidence and CUDA/physical Metal execution for affected native gates, with reproducible commands and fixture identities. Errors: source inspection and model-free tests alone cannot yield a native pass. [paraphrase]

## Boundaries
<!-- scope: business -->

No new public benchmark CLI, external paid judge requirement, model replacement or precision change. Do not replace fn-64 lexical hardening or fn-137 recall-language work; reuse their valid fixtures without inheriting obsolete website instructions. [inferred]

## Decision Context
<!-- scope: both -->

Plan required because real-model coverage, paired measurements and intended-delta oracles interact. This harness measures candidate work; it does not impose an invented universal latency allowance. Aligns with Trustworthy retrieval and evidence and Coherent agent and application surfaces. [inferred]

## Validation and QA

Run unchanged baseline versus itself, injected negative controls, and the synthetic expiry scenario through actual command/API entrypoints. Capture fixture hashes, commands, outputs and platform coverage. Native tests run serially per GPU to avoid self-induced contention. [inferred]

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence. [inferred]

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Requirement coverage

| Requirement | Task |
|---|---|
| R1 | TBD during planning |
| R2 | TBD during planning |
| R3 | TBD during planning |
| R4 | TBD during planning |
| R5 | TBD during planning |
| R6 | TBD during planning |
