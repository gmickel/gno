# Eligible candidates before retrieval top-K

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Selective filters should not hide relevant eligible documents behind globally higher-ranked ineligible documents. The audit reproduced a 201-document lexical fixture where the only eligible hit vanished at limits 1 and 10 but appeared at 21. Global vector top-K before filtering has a related source-level risk.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Apply eligibility to the candidate-selection domain before enforcing the requested result budget, using existing filter/scope semantics. Compare lexical and vector paths with exhaustive eligible selection. Preserve existing ranking/fusion meaning within the eligible set and maintain caller/domain policy before materializing or exposing results.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Keep supported query/filter syntax, public limits and output schemas. Correct false negatives as explicitly intended result changes. Preserve current behavior for invalid filters and unsupported combinations; never relax caller scope to fill a result count.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Cover collection(s), path/exclude, tags, dates, author and active/visibility filters where supported, plus tiny eligible sets, ties, empty sets and K boundaries. Combine restrictive filters with reranking/hybrid fusion. SQLite execution cost matters when exhaustive eligible evaluation is large.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** At limits 1 and 10, the 201-document lexical fixture returns its eligible match; compare complete eligible top-K ordering to an exhaustive oracle. Errors: ineligible or inactive documents never fill short results. [inferred]
- **R2:** Construct and run the corresponding real-vector restrictive-filter cases, ensuring globally high-ranked excluded candidates cannot starve eligible results. Errors: missing vector capability is explicit and does not count as passing the vector path. [inferred]
- **R3:** Preserve query language, ranking and output behavior outside the declared filter-correction cases, including deterministic ties and hybrid evidence. Errors: invalid filters follow existing validation and scope boundaries never widen. [paraphrase]
- **R4:** Measure selective and broad workloads over increasing corpus sizes with actual public retrieval calls, preserving quality under concurrent reads. Errors: unacceptable synchronous stalls or unplanned steady-state regressions block promotion rather than being hidden by average speedups. [paraphrase]
- **R5:** Document corrected filter/limit behavior across affected CLI/MCP/API and hosted guidance, with deterministic regression coverage. Errors: no claim that independent natural-language recall matching is fixed. [inferred]

## Boundaries
<!-- scope: business -->

No fn-137 recall AND/OR semantics change, general BM25 weighting overhaul, new vector backend, approximate nearest-neighbor rollout or request-cache implementation. [inferred]

## Decision Context
<!-- scope: both -->

Plan required because intended result changes and potentially larger eligible scans need a correctness oracle plus cost measurement. Keep query-language work in fn-137 and broader lexical hardening in fn-64 separate. [inferred]

## Validation and QA

Drive keyword/vector/hybrid requests with restrictive scopes through supported surfaces; verify no cross-domain results, oracle parity, valid zero matches and invalid-filter errors. Capture actual SQL/resource timing evidence without exposing private documents. [inferred]

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
