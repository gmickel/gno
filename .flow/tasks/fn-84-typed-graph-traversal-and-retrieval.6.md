---
satisfies: [R7, R8]
---

## Description

Expose graph traversal and retrieval diagnostics as read-only MCP tools: `gno_graph_query` and `gno_query_diagnose`, **wrapping the shared core services** from tasks .3/.4. Correct module placement: graph query near graph/link tools; query diagnose in the query module (it needs query/model/depth-policy logic, not the links module). Existing `gno_links`/`gno_backlinks`/`gno_graph*` stay backward compatible. Disjoint files from REST task (.5) — parallelizable.

**Size:** M
**Files:** `src/mcp/tools/links.ts` (gno_graph_query handler), `src/mcp/tools/query.ts` or new `src/mcp/tools/diagnose.ts` (gno_query_diagnose handler), `src/mcp/tools/index.ts`, `spec/mcp.md`, `docs/MCP.md`, `test/mcp/*.test.ts`

## Approach

- `gno_graph_query` handler near the existing graph/link handlers (`tools/links.ts`: `handleGraph:753`, `handleGraphNeighbors:863`) — calls the **shared traversal core (.3)**. `gno_query_diagnose` handler in `tools/query.ts` (or new `tools/diagnose.ts`) — calls **`diagnoseQueryTarget()` (.4)** — because it needs query pipeline/model/depth-policy context like the existing query tool, NOT the links module.
- Both **read-only** (do not gate behind `ctx.enableWrite`, `index.ts:919`). Define Zod input schemas in `src/mcp/tools/index.ts` (alongside `graphInputSchema:641`, `linksInputSchema:587`); register in `registerTools:826` via `server.tool(...)`.
- Tool descriptions include agent-facing "when to use" guidance (pattern `index.ts:878-914`), e.g. "use `gno_query_diagnose` when an important document is missing from results." Derive enums from source (no drift).
- Spec-first: update `spec/mcp.md` (input/output schema + backward-compat notes) before implementing; reuse `.3`/`.4` output schemas.

## Investigation targets

**Required:**

- `src/mcp/tools/links.ts:753,863,918` — graph handlers + `findShortestPath` (reference)
- `src/mcp/tools/query.ts` — existing query tool (where diagnose handler belongs)
- `src/mcp/tools/index.ts:587,641,826,878-914,919` — input schemas, `registerTools`, description pattern, `enableWrite` gating
- `src/mcp/server.ts:55,163,178` — `ToolContext` ports + registration
- `spec/mcp.md` — tool spec section pattern

## Acceptance

- [ ] `gno_graph_query` (read-only) wraps shared traversal core; handler near graph/link tools
- [ ] `gno_query_diagnose` (read-only) wraps `diagnoseQueryTarget()`; handler in query/diagnose module (NOT links.ts)
- [ ] Both carry agent-facing usage guidance; enums derived from source
- [ ] Existing `gno_links`/`gno_backlinks`/`gno_graph*` unchanged (backward compat tested)
- [ ] `spec/mcp.md` + `docs/MCP.md` updated (tool count + sections)
- [ ] MCP tests cover both new tools + backward compatibility

## Done summary

Added read-only MCP tools gno_graph_query and gno_query_diagnose. Registered input schemas and agent-facing descriptions, wrapped shared graph-query and query-diagnose cores, updated MCP spec/docs, added typed graph query and query diagnose MCP tests, and fixed depth/relation alias validation plus case-insensitive collection handling.

## Evidence

- Commits:
- Tests: bun test test/mcp/tools/query.test.ts test/mcp/links-integration.test.ts (27 pass), bun run lint && bun run lint:check (pass), bun test test/mcp test/spec/schemas/graph-query.test.ts test/spec/schemas/query-diagnose.test.ts test/core/graph-query.test.ts test/pipeline/diagnose.test.ts (136 pass), RepoPrompt review untitled-chat-6B3021: NEEDS_WORK; re-review untitled-chat-3D1416: SHIP
- PRs:
