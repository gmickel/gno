# Stop indexing polling after component unmount

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Leaving the indexing view must stop its polling work. The audit found that an in-flight response can schedule another timer after the component cleanup has already run.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Tie polling requests, response handling and timer scheduling to the lifetime of the existing effect instance. Cleanup cancels or invalidates outstanding work so a late response cannot restart the loop. A new mounted instance owns its own polling lifecycle.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Preserve indexing status content, normal polling behavior while mounted and existing API contracts. A request already sent may settle, but its obsolete response cannot schedule new polling or update the departed view.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Cover delayed success/failure, unmount before response, quick remount, repeated navigation and effect cleanup/restart. Prevent an older instance from changing a newer instance's state.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A deferred response settling after unmount schedules no new timer/request and performs no stale view update. Errors: success and failure both honor cleanup, including an abort rejection. [inferred]
- **R2:** A newly mounted view polls normally with one owned loop, even while an earlier response settles. Errors: repeated mount/cleanup and rapid navigation cannot multiply loops or cancel the new owner. [inferred]
- **R3:** A focused deferred-response regression and live browser network QA demonstrate polling stops after navigation and resumes on return. Errors: source inspection alone does not satisfy the visible lifecycle gate; no API behavior change is introduced. [paraphrase]

## Boundaries
<!-- scope: business -->

No polling-interval redesign, event-stream migration, status API change or unrelated component refactor. [inferred]

## Decision Context
<!-- scope: both -->

No-plan fits one known effect-lifetime race. One implementation unit with a deferred-response test and browser network capture is sufficient. [inferred]

## Validation and QA

Drive the running UI with a deliberately delayed indexing-status response, navigate away before settlement, observe no subsequent polling, return and verify one polling loop. Capture the network evidence and observed view state. [inferred]

Use heavy live QA and focused regression tests, with the full project lint/typecheck/test/docs gates before handoff. Formal plan-review and impl-review stages are disabled by the user; QA stays enabled and plan sync stays disabled. A reachable running surface and captured evidence are required for a QA pass. Missing physical coverage is explicit incomplete acceptance. [paraphrase]

Update affected public behavior/API contracts and product documentation with implementation, including hosted guidance when applicable. Keep private fixtures and machine-local indexes out of committed evidence. [inferred]

## Evidence and provenance

[Canonical audit, final recommendations and probe results](gno://projects/gno/GNO%20Performance%20and%20System%20Cost%20Audit%20-%202026-09-04.md). Research date 2026-09-04; capture date 2026-09-05. Measurements establish the proposed work, not shipped correctness. The audit preserves report names and reproducible synthetic evidence locations. Source tags distinguish user intent from research-derived criteria.

## Requirement coverage

| Requirement | Task |
|---|---|
| R1 | TBD during direct no-plan work |
| R2 | TBD during direct no-plan work |
| R3 | TBD during direct no-plan work |
