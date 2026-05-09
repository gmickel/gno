# Graph report and stats over existing document graph

## Description

Add graph analysis over GNO's existing document graph so users and agents can understand graph health before deeper retrieval changes land.

This task should summarize hubs, bridge-like/high-degree documents, isolated documents, unresolved links, edge-type breakdown, and graph-size/truncation metadata using the current wiki/markdown/similarity graph surfaces.

Docs, Web UI updates when affected, and hosted website updates are part of this task, including GNO docs plus the corresponding `~/work/gno.sh` website content when behavior is user-facing.

## Implementation Notes

Start from the current graph path instead of adding a new graph store: `src/store/sqlite/adapter.ts` `getGraph`, `src/store/types.ts` Graph types, `src/cli/commands/graph.ts`, `src/serve/routes/graph.ts`, and `src/mcp/tools/links.ts` `handleGraph`.

Expected user surfaces:

- CLI/API/MCP graph stats or report output.
- Web UI graph page updates when report fields are useful in the app, especially graph health, unresolved links, hubs, and isolates.
- Schema/docs updates if output shape changes.

Testing focus:

- Link graph with multiple resolved wiki/markdown edges.
- Graph with unresolved links.
- Graph with isolated active documents.
- Similarity enabled, unavailable, and capped/truncated cases.
- Large graph truncation warnings.

## Acceptance

- Graph stats/report output exists for the existing document graph without requiring new code-symbol extraction.
- Output includes hubs/top-degree documents, isolated documents, unresolved-link counts, edge-type breakdown, and existing graph truncation warnings where relevant.
- REST/API, CLI, or MCP-facing schema changes are documented in specs and output schemas as needed.
- Tests cover graph report/stat calculation for linked docs, isolated docs, unresolved links, and similarity-edge availability/fallback.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include targeted tests, `bun run lint:check`, `bun test` where feasible, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

_To be completed when the task is implemented._

## Evidence

_To be completed when the task is implemented._
