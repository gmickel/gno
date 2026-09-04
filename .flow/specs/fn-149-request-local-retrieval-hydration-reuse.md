# Request-local retrieval hydration reuse

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: from the authorized audit synthesis -->

Avoid loading and preparing unrelated chunk text repeatedly during one retrieval request. The audit observed one lexical result hydrating 1,000 chunks and roughly two million characters. Reduce this work while preserving exactly the passages, model inputs, citations and scores the pipeline currently selects.

## Architecture & Data Models
<!-- scope: technical; source: from the authorized audit synthesis -->

Bound hydration to the data needed by the requested pipeline stages and reuse immutable request-local results across those stages. Retain valid candidate/passages selection semantics; ensure related stages use one coherent request view where existing consistency guarantees require it. No shared cross-request cache is needed.

## API Contracts
<!-- scope: technical; source: from the authorized audit synthesis -->

Maintain result formatting, scores, line ranges, evidence hashes, errors and model input bytes. Do not truncate text or change selected chunks as a substitute for avoiding repeated reads.

## Edge Cases & Constraints
<!-- scope: technical; source: from the authorized audit synthesis -->

Cover long documents, many chunks per document, duplicate candidates, rerank/Ask paths, absent content and mutations concurrent with retrieval. Request-local reuse must respect model/preset differences within a request and must be released when the request completes or aborts.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Reduce measured chunk/text hydration or preparation work in the 1,000-chunk fixture while preserving complete deterministic results and actual downstream model inputs. Errors: omitted candidate evidence or shortened input fails parity.
- **R2:** Reuse identical intermediate work only within a request and release it at completion/abort. Errors: stale data cannot cross request, caller, collection or model boundaries.
- **R3:** Exercise lexical, vector, hybrid, rerank and Ask paths with long documents and duplicate candidates, retaining passages, citations, scores and output formatting. Errors: missing content and concurrent mutations preserve the existing consistency/error contract. [paraphrase]
- **R4:** Report allocation/read counts and warm/cold latency with paired real requests; provide focused regression tests and API/CLI QA captures. Errors: warm-cache-only observations or changed candidate selection cannot establish the claimed saving. [paraphrase]

## Boundaries
<!-- scope: business -->

No global cache/invalidation framework, candidate-budget reduction, altered ranking, model-input truncation or eligibility query redesign.

## Strategy Alignment

- **Trustworthy retrieval and evidence**: preserve per-case evidence and inspectable failure states.
- **Local knowledge lifecycle**: bound native/request resource lifetime without hidden loss of knowledge coverage.
- **Coherent agent and application surfaces**: verify actual supported CLI/MCP/API behavior and hosted documentation where changed.

## Decision Context
<!-- scope: both -->

Compact plan required to establish which stages need which content and where equality must hold. Separating this from eligibility fixes makes unintended ranking changes easier to detect.

## Validation and QA

Compare full public results and instrumented model input bytes for large synthetic documents before/after, including sequential requests across an edit and aborted requests. Measure actual hydrated chunk counts and request memory.

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence.

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Planning decisions

Use explicit per-request immutable raw hydration shared through CLI/SDK Ask and verified answer stages. Add targeted mirrorHash/sequence batching only on plain paths that do not need whole-document evidence; preserve full hydration for intent/exclusion. No global cache, cached cross-request failure or new transaction spanning native inference.

All previously inferred requirements were grounded against current source and audit probes during this planning pass. Existing R-IDs and superseded acceptance remain unchanged. New operational bounds are implementation defaults to test, not universal performance promises.

## Execution and ownership

Tasks below form the implementation plan. Each task carries exact files, investigation anchors, focused tests and scope-specific QA. Shared native/store/migration/hosted-doc edits are serialized by ownership across otherwise independent specs. Native QA is serialized per GPU. fn-138 and fn-141 remain superseded evidence records and receive no work.

- Wave 1: fn-149-request-local-retrieval-hydration-reuse.1
- Wave 2 (parallel candidates): fn-149-request-local-retrieval-hydration-reuse.2, fn-149-request-local-retrieval-hydration-reuse.3
- Wave 3: fn-149-request-local-retrieval-hydration-reuse.4

## Early proof point

fn-149-request-local-retrieval-hydration-reuse.1 pins the governing contract and negative cases before dependent implementation. If this proof fails, correct the contract or fixture within that task before continuing; do not weaken parent acceptance.

## Requirement coverage

| Requirement | Tasks |
|---|---|
| R1 | fn-149-request-local-retrieval-hydration-reuse.1, fn-149-request-local-retrieval-hydration-reuse.2, fn-149-request-local-retrieval-hydration-reuse.3 |
| R2 | fn-149-request-local-retrieval-hydration-reuse.1, fn-149-request-local-retrieval-hydration-reuse.2, fn-149-request-local-retrieval-hydration-reuse.4 |
| R3 | fn-149-request-local-retrieval-hydration-reuse.2, fn-149-request-local-retrieval-hydration-reuse.3, fn-149-request-local-retrieval-hydration-reuse.4 |
| R4 | fn-149-request-local-retrieval-hydration-reuse.4 |
