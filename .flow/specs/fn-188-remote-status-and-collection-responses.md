# Remote status and collection responses expose owner config paths

## Goal & Context
<!-- scope: business; source: inferred -->

Remote callers no longer receive document host paths, but owner configuration paths still reach them: the collection root `path` in REST `/api/collections` and `/api/status`, MCP `gno_status`, and status `configPath` / `dbPath`. These reveal the owner's home directory and folder layout to any remote client of the API or HTTP MCP.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] Remote-reachable status and collection responses (REST and HTTP MCP, using the same remote classification as document results) omit or replace host configuration paths (collection roots, config file, database path) with non-host identifiers; local owner surfaces keep them. Errors: the Collections page and status views keep working for the local owner and degrade gracefully for remote viewers.
- **R2:** [inferred] Status/collection schemas and API/MCP docs describe which fields are local-only; contract tests cover one remote and one local caller.

## Boundaries
<!-- scope: business -->

- [inferred] No new auth model; reuse the existing remote classification.
