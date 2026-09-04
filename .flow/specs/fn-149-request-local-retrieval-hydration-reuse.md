# Request-local retrieval hydration reuse

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Avoid loading and preparing unrelated chunk text repeatedly during one retrieval request. The audit observed one lexical result hydrating 1,000 chunks and roughly two million characters. Reduce this work while preserving exactly the passages, model inputs, citations and scores the pipeline currently selects.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Bound hydration to the data needed by the requested pipeline stages and reuse immutable request-local results across those stages. Retain valid candidate/passages selection semantics; ensure related stages use one coherent request view where existing consistency guarantees require it. No shared cross-request cache is needed.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Maintain result formatting, scores, line ranges, evidence hashes, errors and model input bytes. Do not truncate text or change selected chunks as a substitute for avoiding repeated reads.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Cover long documents, many chunks per document, duplicate candidates, rerank/Ask paths, absent content and mutations concurrent with retrieval. Request-local reuse must respect model/preset differences within a request and must be released when the request completes or aborts.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Reduce measured chunk/text hydration or preparation work in the 1,000-chunk fixture while preserving complete deterministic results and actual downstream model inputs. Errors: omitted candidate evidence or shortened input fails parity. [inferred]
- **R2:** Reuse identical intermediate work only within a request and release it at completion/abort. Errors: stale data cannot cross request, caller, collection or model boundaries. [inferred]
- **R3:** Exercise lexical, vector, hybrid, rerank and Ask paths with long documents and duplicate candidates, retaining passages, citations, scores and output formatting. Errors: missing content and concurrent mutations preserve the existing consistency/error contract. [paraphrase]
- **R4:** Report allocation/read counts and warm/cold latency with paired real requests; provide focused regression tests and API/CLI QA captures. Errors: warm-cache-only observations or changed candidate selection cannot establish the claimed saving. [paraphrase]

## Boundaries
<!-- scope: business -->

No global cache/invalidation framework, candidate-budget reduction, altered ranking, model-input truncation or eligibility query redesign. [inferred]

## Decision Context
<!-- scope: both -->

Compact plan required to establish which stages need which content and where equality must hold. Separating this from eligibility fixes makes unintended ranking changes easier to detect. [inferred]

## Validation and QA

Compare full public results and instrumented model input bytes for large synthetic documents before/after, including sequential requests across an edit and aborted requests. Measure actual hydrated chunk counts and request memory. [inferred]

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
