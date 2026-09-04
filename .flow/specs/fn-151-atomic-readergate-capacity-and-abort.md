# Atomic ReaderGate capacity and abort handoff

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Keep resident request admission within its configured capacity during release and cancellation. The audit reproduced a legal handoff reaching two active readers with a limit of one, plus an abort handoff leaving zero active readers and one stranded waiter.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Make release-to-waiter ownership transfer atomic within the existing gate. A granted slot has exactly one owner; cancellation either removes an ungranted waiter or returns its assigned capacity exactly once. Preserve existing admission order and public capacity configuration.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Preserve request cancellation/error behavior and gate API. A canceled waiter never enters work, and a live waiter cannot remain stranded while capacity is available.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Cover limit one and larger limits, release concurrent with fresh acquisition, abort before/at/after handoff, repeated release protection and empty queues. Maintain capacity bounds across every transition.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** The release/fresh-acquire schedule never exceeds the configured active-reader limit, including the reproduced limit-one case. Errors: no duplicate slot ownership or double-release under reentrant completion. [inferred]
- **R2:** The abort/handoff schedule cannot strand a non-canceled queued reader while capacity is free; canceled waiters do not enter work. Errors: abort before, during and after grant releases or transfers capacity exactly once. [inferred]
- **R3:** Focused deterministic schedule regressions pass alongside real resident API concurrency/disconnect QA. Errors: hanging requests, leaked slots and changed request outputs fail; no error surface beyond existing admission/cancellation contracts. [paraphrase]

## Boundaries
<!-- scope: business -->

No new scheduler, priority policy, native worker design or public configuration change. [inferred]

## Decision Context
<!-- scope: both -->

No-plan fits a bounded primitive with two concrete failing schedules and an established contract. Execute as one focused implementation unit with regression tests and live concurrency QA. [inferred]

## Validation and QA

Run deterministic handoff schedules, then concurrent real read requests and client disconnects against an isolated serve instance. Assert bounded active work, eventual completion and unchanged successful outputs. [inferred]

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
