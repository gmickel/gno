---
satisfies: [R2, R3, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.3 Add product-faithful GNO MCP adapter and instrumentation

## Description
Measure the shipped GNO query/get workflow through its real MCP boundary with exact lifecycle and context instrumentation.

**Size:** M
**Files:** `evals/agentic/adapters/gno-mcp.ts`, `evals/agentic/lifecycle/gno-mcp.ts`, `test/evals/agentic/gno-mcp-adapter.test.ts`, `spec/evals-agentic.md`

### Approach
- Spawn the real isolated stdio MCP server and invoke shipped tool names/schemas; do not import retrieval pipelines or add hidden shortcuts unavailable to an agent.
- Follow the installed skill's search/query then get/multi_get workflow, capturing normalized arguments/order, returned exact evidence coordinates, repeated reads, filters, model-visible bytes, errors, and stop timing.
- Implement exact lifecycle semantics: cold includes new server/store/model spawn through final envelope per task trial; warm uses one ready, pre-indexed process with one unscored readiness call, preserves process/model/store state across a cohort, resets only agent-visible state, and excludes initial setup.
- Add deterministic fake-process contract tests plus isolated real-MCP integration coverage.

### Investigation targets
**Required** (read before coding):
- `assets/skill/SKILL.md`
- `docs/MCP.md:37-100`
- `src/mcp/server.ts`
- `src/mcp/tools/query.ts`
- `src/mcp/tools/multi-get.ts`
- Planned task 2 outputs: `evals/agentic/adapter.ts`, `evals/agentic/runner.ts`

**Optional** (reference as needed):
- `src/cli/commands/get.ts`

## Acceptance
- [ ] Adapter traffic uses only the shipped MCP contract and fails if a required tool/schema is unavailable; no pipeline-internal shortcut exists.
- [ ] Every call/result/read/filter/error is normalized and exact model-visible UTF-8 bytes include repeated and error payloads.
- [ ] Cold and warm receipts match the spec definitions and cannot be compared across lifecycle labels.
- [ ] Isolated integration proves a fixture task completes through the real stdio MCP server without global config or production DB mutation.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
