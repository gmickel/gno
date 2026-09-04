# Restoration and unchanged embedding preservation

## Conversation Evidence

> user: "before we capture all of this into flow-next specs (decide on no-plan vs plan specs and how many specs based on complexity and risk etc), we need to also be sure that nothing will cause a worsening in retrieval performance"
> user: "you can easily creat new longer inputs to do a bit more testing if needed and yes i agree we need to detail the tradeoffs between memory and slightly slower cold next query etc, in general people use gno agentically ie. through claude code/codex etc and are not expecting instant results probably"
> user: "ok, great we will be implementing with heavy QA and not impl-reviews/plan-reviews, more fitting here i think, we should set the review backend to none in flow next and esure QA is turned on, also deactivate plan sync if activated"
> user: "commit and push, then capture all specs, again decide on no-plan, plan based on our needs"

## Goal & Context
<!-- scope: business; source: [inferred] from the authorized audit synthesis -->

Restore searchability when an identical deleted document returns and preserve valid vectors when embedding inputs are unchanged. The real-store audit reproduced inactive identical restoration, vector deletion on a same-title duplicate, and vector deletion after a canonical-equivalent whitespace edit. This scope incorporates every fn-138 acceptance requirement.

## Architecture & Data Models
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Treat active document state, source identity, canonical mirror/chunks and embedding-input identity as separate invariants. Reactivation is a real document-state change even when content hashes match. Preserve vectors only when their actual formatted embedding input, chunk/model identity and relevant title policy remain equivalent. Shared mirrors must not let one source mutation destroy valid vectors for another source.

## API Contracts
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Restored documents become visible through search/query and produce the expected change-journal event for changes consumers. Preserve vector dimensions/model identity and normal sync error reporting. Do not invent a second reactivation event schema; use the established change contract with a truthful state transition.

## Edge Cases & Constraints
<!-- scope: technical; source: [inferred] from the authorized audit synthesis -->

Identical bodies under filename-derived Alpha/Beta titles can have the same mirror hash but different formatted embedding inputs. Cover duplicate mirrors, title changes, canonical-equivalent edits, true content changes, delete/restore cycles, inactive rows and failures midway through sync. Keep model/index state local and avoid cloud-placeholder hydration.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Retain fn-138 R1: delete a file, sync, restore identical bytes at the same path and sync; the document is active and searchable again. Emit the expected reactivation change event. Errors: unchanged hashes cannot suppress state restoration, and failed sync cannot journal an uncommitted transition. [inferred]
- **R2:** Retain fn-138 R2 with a regression test for identical restoration and extend it to repeated cycles and change consumers. Errors: absent files remain inactive, repeated no-op sync does not emit duplicate restoration history. [inferred]
- **R3:** Same-title duplicate ingestion and canonical-equivalent edits preserve valid unchanged embeddings, avoiding unnecessary model work. Errors: shared chunk replacement or cascading deletes cannot erase valid vectors belonging to unchanged inputs. [inferred]
- **R4:** Changed title-derived input, chunk text or model identity invalidates/recomputes the affected vector even when the mirror hash matches. Errors: same-body Alpha/Beta filename-title fixtures must not reuse a vector for different formatted input. [inferred]
- **R5:** True content changes, duplicates and partial failures leave document/chunk/vector/journal state consistent; compare search and semantic outputs with a clean-rebuild oracle. Errors: rollback cannot leave active documents silently missing previously valid semantic coverage. [paraphrase]
- **R6:** Retain fn-138 R3 by removing obsolete restoration known-gap guidance from OpenClaw and memory documentation, and describe the repaired semantics. Errors: documentation cannot claim unrelated retrieval or cloud-provider defects fixed. [inferred]

## Boundaries
<!-- scope: business -->

No changed title-formatting policy merely to improve cache hits, model migration, broad chunking rewrite or incremental graph implementation. Global graph work has its own successor. Existing fn-139 status-listing scope stays separate. [inferred]

## Decision Context
<!-- scope: both -->

Plan required because active state, mirror sharing, vector foreign keys and formatted embedding identity interact. A mirror-hash-only shortcut is disproven by the title fixture. Reactivation and vector deletion are distinct defects that share the same correctness boundary. [inferred]

## Validation and QA

Use actual sync plus CLI/API search and semantic query on a synthetic duplicate/title/restoration matrix. Compare against a clean rebuild, inspect durable changes, measure embedding call counts and test rollback. Include physical no-hydration checks if source-reading behavior changes. [inferred]

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
