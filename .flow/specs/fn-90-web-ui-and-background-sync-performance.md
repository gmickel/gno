# fn-90 Web UI and background sync performance

## Goal & Context

Remove production-scale stalls measured in the local Web UI: `/api/status` takes roughly 9.6 seconds and duplicate Dashboard callers serialize to roughly 16 seconds; watcher/full-sync typed-edge projection blocks unrelated requests and contributed to an 853.6-second full update.

## Architecture & Data Models

Replace correlated status subqueries with set-based aggregation over distinct active collection/mirror pairs. Coalesce concurrent status builds without stale cross-request caching and remove the Dashboard's duplicate initial status fetch.

Separate ingestion from graph projection. `syncAll` ingests every collection and projects once. Path/watch sync processes only reported paths, reprojects changed sources plus known backlink sources, and yields during larger projection loops so Bun can serve unrelated requests.

## API Contracts

Status response shapes remain unchanged except diagnostics added by fn-89. Sync result counting semantics remain compatible. Watch callbacks report only the paths actually processed. No endpoint gains a blocking global projection per file event.

## Edge Cases & Constraints

- Shared mirrors count once per collection for chunks and embeddings.
- Stale model/fingerprint vectors remain backlog.
- Deleted watched files become inactive without rescanning their collection.
- Link target additions/deletions update changed and known backlink sources; full sync remains the canonical full reconciliation boundary.
- Projection failures remain visible in sync errors.
- Yielding must not introduce concurrent writes through the same store.

## Acceptance Criteria

- **R1:** Production-scale warm `getStatus` falls below 100ms while preserving counts for shared mirrors and stale fingerprints.
- **R2:** Concurrent `/api/status` callers share one in-flight build, and Dashboard emits one initial status request.
- **R3:** `syncAll` performs one global typed-edge projection regardless of collection count.
- **R4:** A one-file watcher event processes only its reported path and does not walk the collection or project every document.
- **R5:** Changed sources and known backlink sources retain typed-edge correctness; full sync retains complete graph parity.
- **R6:** Large projection loops yield often enough for health/docs/browse requests to remain responsive.
- **R7:** Regression tests cover status scale, full-sync projection count, watcher add/change/delete, and graph parity.
- **R8:** Production timing evidence records status, watcher, full-update, and unrelated-request responsiveness.

## Boundaries

No new database engine, generic worker pool, graph schema redesign, frontend visual redesign, or embedding/ranking change.

## Decision Context

Set-based SQL addresses the measured root cause without masking it with long-lived caching. Separating ingestion and projection removes redundant global work. Incremental watcher processing uses existing link/backlink data; full sync remains the exact reconciliation path for relation targets that cannot be inferred from stored resolved edges alone.
