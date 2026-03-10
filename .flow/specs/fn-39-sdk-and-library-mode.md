# SDK and library mode

## Goal

Make GNO usable as a first-class importable library, not only a CLI / MCP / Web server.

## Why this matters

Current GNO surfaces are strong for human and agent use through the CLI, MCP server, Web UI, and REST API. What is still missing is a supported package-level API for other applications to call directly without shelling out or standing up a local server.

A clean SDK unlocks:

- editor/plugin integrations
- desktop app integrations
- local automation / background jobs
- test harnesses that do not need CLI subprocesses
- other apps embedding GNO as a retrieval engine

## Current gap

GNO already has the internal pieces:

- store layer
- pipeline layer
- configuration loading
- model/runtime initialization
- indexing and retrieval commands

But these are not packaged behind a stable, documented public SDK contract.

## Start Here

A fresh agent should be able to execute this epic cold in this order:

1. Inspect current public package surface in `package.json` and `src/index.ts`
2. Define the minimal supported SDK API and what remains internal
3. Implement package exports and TypeScript-friendly entrypoints
4. Add lifecycle-safe constructors/helpers for library consumers
5. Add contract tests and examples
6. Update docs and website to present SDK mode as a supported integration path

## Non-goals

- Do not rebuild the entire architecture around dependency injection.
- Do not expose every internal function as public API.
- Do not break existing CLI / MCP / Web behavior.
- Do not require a daemon/server for basic SDK use.

## Required public surface

At minimum, the SDK should allow a consumer to:

- create/open a store against a db path and config
- run BM25 search
- run vector / hybrid query when configured
- run ask/retrieval calls
- get documents / multi-get style access
- trigger indexing/update operations programmatically
- close/dispose resources cleanly

The design may expose either:

- one high-level `createStore(...)` / `createClient(...)` style API
  or
- a small set of explicitly named constructors

But it must be stable, documented, and typed.

## Required design constraints

- Inline config must be supported; library consumers should not be forced to write YAML files.
- File-path config loading can still be supported as a convenience.
- Resource lifecycle must be explicit: open/init and dispose/close paths must be documented.
- TypeScript usage must work cleanly through `main` / `types` / `exports`.
- Package consumers should not need to shell out to the CLI for normal use.

## Packaging requirements

- `package.json` must declare a clean importable surface.
- Type declarations must resolve correctly.
- Public API entrypoint must be separate from CLI-only concerns.
- Examples should work in both TS and JS usage where practical.

## Testing requirements

Must include:

- package-surface tests (import + types)
- one or more end-to-end SDK usage tests
- resource lifecycle tests (open/close/dispose)
- parity tests against at least one CLI/API behavior for a representative flow

## Docs and website requirements

This epic must include a full docs/website update.

Minimum doc updates:

- README SDK section with examples
- dedicated user-facing docs page for library mode / SDK usage
- API/architecture docs updated if needed
- website feature copy / docs navigation updated
- website examples or snippets added if the site has a suitable place for them

The docs must be good enough that a new user can embed GNO into another app without reading source.

## External references

Useful references for the implementing agent:

- local upstream reference implementation already cloned under `~/repos`
- upstream package export pattern in its `package.json`
- upstream SDK/package entrypoint pattern in its `src/index.ts`
- upstream store wrapper pattern in its `src/store.ts`

These are references only. GNO’s SDK should fit GNO’s architecture and naming.

## Deliverables

- public SDK entrypoint
- package export/type configuration
- one or more example snippets
- tests proving import/use/dispose behavior
- full docs + website update
- recommendation of what is public/stable vs internal/private

## Acceptance

- A fresh app can import GNO directly from the package and perform indexed retrieval without CLI subprocesses.
- Inline config is supported.
- Public types resolve correctly.
- CLI / MCP / Web regressions are not introduced.
- Docs + website are updated enough for a fresh user to adopt the SDK.
- The public API boundary is intentionally documented and limited.
