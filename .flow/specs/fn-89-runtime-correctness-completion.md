# fn-89 Runtime correctness completion

## Goal & Context

Close two acceptance gaps discovered while auditing historical runtime-hardening work: indexed `gno://` references must never read the wrong index through MCP or the SDK, and vector-runtime failures must expose actionable diagnostics in Web UI health/status. Correct existing documentation that currently promises the incomplete behavior.

## Architecture & Data Models

Use one shared indexed-reference resolver across SDK and MCP. A request whose explicit index differs from the active context opens a scoped `SqliteAdapter`, syncs configured collections/contexts, executes the read, and closes the store. Same-index and unindexed references reuse the active store. Persisted document URIs remain canonical and index-free.

Expose vector adapter `loadError` and `guidance` through the existing status health-check model without changing ranking or BM25 fallback behavior.

## API Contracts

- `get` accepts `gno://collection/path?index=name` and reads `name` across CLI, MCP, resources, and SDK.
- `multi-get` accepts one effective index; mixed explicit indexes or incompatible indexed/unindexed refs return validation errors.
- Returned URIs carry the effective non-default index.
- `/api/status` includes a warning health check containing vector failure reason and recovery guidance when sqlite-vec is unavailable.
- Existing fields remain backward compatible.

## Edge Cases & Constraints

- Never create a missing requested index as a side effect of a read.
- Default and blank index names remain canonical.
- Line suffixes and URL-encoded paths preserve index metadata.
- Scoped stores close on success and failure.
- Inline SDK configs continue to work.
- Diagnostic output must not log repeatedly on status polling.

## Acceptance Criteria

- **R1:** MCP get and document resources read the explicitly requested index rather than the server's active index.
- **R2:** SDK get and multiGet read the explicitly requested index and reject ambiguous mixed-index batches.
- **R3:** Missing indexed databases fail clearly without falling back to the active/default index.
- **R4:** Cross-index tests use different content at the same URI and prove the correct content is returned.
- **R5:** Web UI status contains the preserved sqlite-vec load reason and actionable guidance without repeated warning output.
- **R6:** CLI behavior, canonical persisted URIs, BM25 fallback, and current schemas remain compatible.
- **R7:** Core docs, skill references, changelog, and hosted gno.sh documentation describe only behavior verified by tests.

## Boundaries

No cross-index writes, multi-index search aggregation, ranking changes, database URI migration, or new vector backend.

## Decision Context

A scoped store keeps index identity at API boundaries and avoids contaminating persisted rows. A shared resolver prevents the CLI, MCP, and SDK from drifting. Health-check diagnostics reuse the existing Web UI model instead of inventing a second diagnostics endpoint.
