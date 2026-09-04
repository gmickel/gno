# Eligible candidates before retrieval top-K

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: from the authorized audit synthesis -->

Selective filters should not hide relevant eligible documents behind globally higher-ranked ineligible documents. The audit reproduced a 201-document lexical fixture where the only eligible hit vanished at limits 1 and 10 but appeared at 21. Global vector top-K before filtering has a related source-level risk.

## Architecture & Data Models
<!-- scope: technical; source: from the authorized audit synthesis -->

Apply eligibility to the candidate-selection domain before enforcing the requested result budget, using existing filter/scope semantics. Compare lexical and vector paths with exhaustive eligible selection. Preserve existing ranking/fusion meaning within the eligible set and maintain caller/domain policy before materializing or exposing results.

## API Contracts
<!-- scope: technical; source: from the authorized audit synthesis -->

Keep supported query/filter syntax, public limits and output schemas. Correct false negatives as explicitly intended result changes. Preserve current behavior for invalid filters and unsupported combinations; never relax caller scope to fill a result count.

## Edge Cases & Constraints
<!-- scope: technical; source: from the authorized audit synthesis -->

Cover collection(s), path/exclude, tags, dates, author and active/visibility filters where supported, plus tiny eligible sets, ties, empty sets and K boundaries. Combine restrictive filters with reranking/hybrid fusion. SQLite execution cost matters when exhaustive eligible evaluation is large.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** At limits 1 and 10, the 201-document lexical fixture returns its eligible match; compare complete eligible top-K ordering to an exhaustive oracle. Errors: ineligible or inactive documents never fill short results.
- **R2:** Construct and run the corresponding real-vector restrictive-filter cases, ensuring globally high-ranked excluded candidates cannot starve eligible results. Errors: missing vector capability is explicit and does not count as passing the vector path.
- **R3:** Preserve query language, ranking and output behavior outside the declared filter-correction cases, including deterministic ties and hybrid evidence. Errors: invalid filters follow existing validation and scope boundaries never widen. [paraphrase]
- **R4:** Measure selective and broad workloads over increasing corpus sizes with actual public retrieval calls, preserving quality under concurrent reads. Errors: unacceptable synchronous stalls or unplanned steady-state regressions block promotion rather than being hidden by average speedups. [paraphrase]
- **R5:** Document corrected filter/limit behavior across affected CLI/MCP/API and hosted guidance, with deterministic regression coverage. Errors: no claim that independent natural-language recall matching is fixed.

## Boundaries
<!-- scope: business -->

No fn-137 recall AND/OR semantics change, general BM25 weighting overhaul, new vector backend, approximate nearest-neighbor rollout or request-cache implementation.

## Strategy Alignment

- **Trustworthy retrieval and evidence**: preserve per-case evidence and inspectable failure states.
- **Local knowledge lifecycle**: bound native/request resource lifetime without hidden loss of knowledge coverage.
- **Coherent agent and application surfaces**: verify actual supported CLI/MCP/API behavior and hosted documentation where changed.

## Decision Context
<!-- scope: both -->

Plan required because intended result changes and potentially larger eligible scans need a correctness oracle plus cost measurement. Keep query-language work in fn-137 and broader lexical hardening in fn-64 separate.

## Validation and QA

Drive keyword/vector/hybrid requests with restrictive scopes through supported surfaces; verify no cross-domain results, oracle parity, valid zero matches and invalid-filter errors. Capture actual SQL/resource timing evidence without exposing private documents.

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence.

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Planning decisions

Eligibility is document ownership plus relevant chunk predicates, before candidate limiting. Empty allowlists deny all; scopes intersect; metadata failure fails closed. Preserve whole-document exclusions, language, dedup/minScore and supported recency/project-affinity semantics. Extend existing exact scoped-distance support rather than fixed global overfetch; compose with input variants from fn-147.

All previously inferred requirements were grounded against current source and audit probes during this planning pass. Existing R-IDs and superseded acceptance remain unchanged. New operational bounds are implementation defaults to test, not universal performance promises.

## Execution and ownership

Tasks below form the implementation plan. Each task carries exact files, investigation anchors, focused tests and scope-specific QA. Shared native/store/migration/hosted-doc edits are serialized by ownership across otherwise independent specs. Native QA is serialized per GPU. fn-138 and fn-141 remain superseded evidence records and receive no work.

- Wave 1: fn-148-eligible-candidates-before-retrieval.1
- Wave 2: fn-148-eligible-candidates-before-retrieval.2
- Wave 3: fn-148-eligible-candidates-before-retrieval.3
- Wave 4: fn-148-eligible-candidates-before-retrieval.4

## Early proof point

fn-148-eligible-candidates-before-retrieval.1 pins the governing contract and negative cases before dependent implementation. If this proof fails, correct the contract or fixture within that task before continuing; do not weaken parent acceptance.

## Requirement coverage

| Requirement | Tasks |
|---|---|
| R1 | fn-148-eligible-candidates-before-retrieval.1, fn-148-eligible-candidates-before-retrieval.2 |
| R2 | fn-148-eligible-candidates-before-retrieval.1, fn-148-eligible-candidates-before-retrieval.3 |
| R3 | fn-148-eligible-candidates-before-retrieval.1, fn-148-eligible-candidates-before-retrieval.2, fn-148-eligible-candidates-before-retrieval.3 |
| R4 | fn-148-eligible-candidates-before-retrieval.4 |
| R5 | fn-148-eligible-candidates-before-retrieval.4 |
