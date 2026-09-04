# Cancellation and bounded background inference

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Agent foreground queries must not compete with abandoned native work or an unlimited background embedding drain. The audit found timeout races that stop waiting without stopping native work, a discarded admitted REST signal, global backlog draining without a duration budget, and shutdown waiting indefinitely for completion.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Extend the native lifecycle owner with end-to-end cancellation and bounded background scheduling. Propagate request abort and deadline ownership through admission and native ports. Keep leases and queue capacity occupied until native work actually settles. Background jobs run resumable bounded units and yield to foreground demand; shutdown drains or terminates owned child work according to an explicit bounded policy.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Preserve current cancellation/error semantics across CLI/MCP/REST and keep timeout distinct from successful completion. A canceled operation cannot publish a late response or report unfinished embeddings as complete. Any new operational limits must be documented and validated consistently rather than leaving ignored settings.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Native cancellation support varies by operation. When direct cancellation cannot settle work, the lifecycle owner must contain it safely without killing unrelated active work or retrying writes. Handle abort before admission, during load, during inference and after native completion but before response. Preserve completed checkpoint work and pending backlog across shutdown.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A request abort or timeout reaches every participating inference stage and suppresses late publication. Errors: non-cancelable native work retains its lease until settlement or controlled child retirement; no phantom free capacity. [inferred]
- **R2:** Bound native admission and background work per scheduling turn, preserving all unfinished backlog for resume and foreground access under sustained background load. Errors: interrupted/failed work is not marked embedded, dropped or duplicated as a completed write. [inferred]
- **R3:** Use model-specific leases so background embedding does not retain unrelated generation/reranking weights. Errors: long active work cannot be evicted by another model timeout or release. [inferred]
- **R4:** Shutdown has a documented finite completion policy tested with stuck native work, and preserves durable store/job consistency. Errors: termination cannot strand a write transaction, misreport job completion or leave an owned child running. [inferred]
- **R5:** Compare real foreground query results and citations under idle and background load; report foreground latency, cancellation latency, queue occupancy and memory. Errors: quality loss, stale callbacks and silent fallback fail QA; resource improvement cannot be obtained by dropping valid work. [paraphrase]
- **R6:** Document effective timeout/background controls and demonstrate their behavior through actual API/MCP cancellation and daemon shutdown. Errors: accepted but ignored settings are failures; unsupported controls receive explicit validation. [inferred]

## Boundaries
<!-- scope: business -->

No second worker owner, new global inference broker, priority system unrelated to foreground/background demand or approximate retrieval shortcuts. Reuse the native lifecycle contract; do not ship scheduling against a competing process model. [inferred]

## Decision Context
<!-- scope: both -->

Plan required for native completion ownership, budgets, queue backpressure and shutdown consistency. Numeric turn and shutdown budgets must be selected from measured native behavior during planning, with tests proving finite bounds rather than an arbitrary universal query SLA. [inferred]

## Validation and QA

Cancel real requests before/during model load and scoring, disconnect clients, run foreground queries alongside backlog embedding, and stop only an isolated daemon with work in flight. Verify backlog resumes and complete results match unloaded controls. [inferred]

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
