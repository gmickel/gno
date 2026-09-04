# Incremental graph reconciliation with global parity

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: from the authorized audit synthesis -->

A narrow collection sync should avoid rewriting an unchanged global graph while retaining cross-collection links. One unchanged source with 1,000 outside linked documents caused 1,001 content reads and 2,000 actual edge-row mutations. Adding/deleting a target changed edges owned by another collection, proving collection-only reconciliation would be incorrect.

## Architecture & Data Models
<!-- scope: technical; source: from the authorized audit synthesis -->

Reconcile affected graph identities and references incrementally, with full global reconciliation as the correctness oracle and recovery path. Account for incoming references from unchanged collections, ambiguity changes and configuration changes. Avoid global content rereads and identical edge churn for a genuinely unchanged scoped sync.

## API Contracts
<!-- scope: technical; source: from the authorized audit synthesis -->

Preserve graph edges, diagnostics, unresolved/ambiguous link semantics, ordering where guaranteed, and visibility boundaries exposed by backlinks/graph/impact/change consumers. No response shape change is assumed. Full rebuild must remain available for repair and comparison.

## Edge Cases & Constraints
<!-- scope: technical; source: from the authorized audit synthesis -->

Test add/delete/restore/rename, title change, shared targets, ambiguous names becoming unique or vice versa, cross-collection references, collection configuration changes, failed sync and crash recovery. Do not equate a small returned graph limit with bounded internal work.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** An unchanged scoped sync over the 1,001-document fixture avoids the measured global content-read and unchanged edge-delete/insert amplification; record exact reads/mutations against baseline. Errors: skipping legitimate incoming-reference updates fails acceptance.
- **R2:** After each mutation in the cross-collection matrix, the incremental graph equals complete global reconciliation in edges and supported diagnostics. Errors: dangling, stale, missing and incorrectly disambiguated references fail per-case equality. [paraphrase]
- **R3:** Interrupted or failed reconciliation leaves a consistent recoverable graph and a complete rebuild restores oracle parity. Errors: partial work cannot silently become authoritative complete state.
- **R4:** Verify backlinks/graph/impact behavior through real supported surfaces before and after mutations, respecting active/visibility filters and domain boundaries. Errors: hidden/inactive source leakage or stale externally owned edges fails QA. [paraphrase]
- **R5:** Measure no-op, narrow-change and broad-change sync over increasing graph sizes, and document operational invalidation/rebuild behavior. Errors: synthetic stage timings cannot be presented as attribution for the earlier 66-second vault index.

## Boundaries
<!-- scope: business -->

No graph-response caching/worker rewrite, new graph ranking, reduced relationship coverage or selected-collection-only shortcut. Source ingestion/vector identity remains owned by its separate scope.

## Strategy Alignment

- **Trustworthy retrieval and evidence**: preserve per-case evidence and inspectable failure states.
- **Local knowledge lifecycle**: preserve source, vector and graph identity through mutation and recovery.
- **Coherent agent and application surfaces**: verify actual supported CLI/MCP/API behavior and hosted documentation where changed.

## Decision Context
<!-- scope: both -->

Plan required for incoming references, ambiguity and invalidation across collections. The measured amplification supports incremental work, while the cross-collection oracle prohibits a naive scope restriction.

## Validation and QA

Run the real sync service and public graph consumers against a synthetic cross-collection mutation sequence. Compare every state with a separately rebuilt oracle and count actual content reads and SQL edge mutations. Exercise recovery without the live vault.

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence.

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Planning decisions

Persist unresolved frontmatter references alongside existing parsed links, plus projection version/config/dirty state. Affected closure includes old and new target identities and cross-collection incoming/ambiguity changes. Preserve full-reconciliation fallback and oracle. Equal edge sets avoid delete/insert churn; completion state commits only with successful projection.

All previously inferred requirements were grounded against current source and audit probes during this planning pass. Existing R-IDs and superseded acceptance remain unchanged. New operational bounds are implementation defaults to test, not universal performance promises.

## Execution and ownership

Tasks below form the implementation plan. Each task carries exact files, investigation anchors, focused tests and scope-specific QA. Shared native/store/migration/hosted-doc edits are serialized by ownership across otherwise independent specs. Native QA is serialized per GPU. fn-138 and fn-141 remain superseded evidence records and receive no work.

- Wave 1: fn-150-incremental-graph-reconciliation-with.1
- Wave 2: fn-150-incremental-graph-reconciliation-with.2
- Wave 3: fn-150-incremental-graph-reconciliation-with.3
- Wave 4: fn-150-incremental-graph-reconciliation-with.4
- Wave 5: fn-150-incremental-graph-reconciliation-with.5

## Early proof point

fn-150-incremental-graph-reconciliation-with.1 pins the governing contract and negative cases before dependent implementation. If this proof fails, correct the contract or fixture within that task before continuing; do not weaken parent acceptance.

## Requirement coverage

| Requirement | Tasks |
|---|---|
| R1 | fn-150-incremental-graph-reconciliation-with.1, fn-150-incremental-graph-reconciliation-with.3, fn-150-incremental-graph-reconciliation-with.4 |
| R2 | fn-150-incremental-graph-reconciliation-with.1, fn-150-incremental-graph-reconciliation-with.2, fn-150-incremental-graph-reconciliation-with.3 |
| R3 | fn-150-incremental-graph-reconciliation-with.2, fn-150-incremental-graph-reconciliation-with.4 |
| R4 | fn-150-incremental-graph-reconciliation-with.1, fn-150-incremental-graph-reconciliation-with.3, fn-150-incremental-graph-reconciliation-with.5 |
| R5 | fn-150-incremental-graph-reconciliation-with.5 |
