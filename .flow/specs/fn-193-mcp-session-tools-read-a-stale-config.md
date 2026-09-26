# MCP session tools read a stale config

## Goal & Context

The MCP session tools (`gno_sessions_status`, and the import and automation tools that resolve a source or profile by id) build their `SessionsService` from the config the MCP server loaded at start (`ctx.config` in `src/mcp/tools/sessions.ts`). When a source or automation profile is added or removed with the CLI while an MCP server runs (stdio, or the resident HTTP endpoint), these tools keep answering from the old source list until the server restarts. fn-185 fixed the same gap for the Web UI and REST `/api/sessions/status`, which now re-read the config file per request and adopt it when it changed.

## Acceptance Criteria

- **R1:** Reproduce first: with a running stdio MCP server and a running `gno serve` HTTP `/mcp`, add a source with the CLI and call `gno_sessions_status`. Record the observed result. If both already report the new source, close this spec with that evidence.
- **R2:** Otherwise, the session tools answer from the current config file, with the same binding checks and error handling as the REST route (unreadable config is an error, never served stale; a config rebound to another index is refused). Reuse the fn-185 refresh path rather than adding a second one.
- **R3:** A test covers CLI add and remove seen by `gno_sessions_status` without a restart, for stdio and resident HTTP.

## Boundaries

- Session tools only; no general config hot-reload for other MCP tools.
- Remote-caller redaction and write gating stay unchanged.
