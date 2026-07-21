---
satisfies: [R2, R3, R6]
---
# fn-99-resident-local-context-gateway.1 Extract one resident runtime and shared MCP tool context

## Description
Deliver extract one resident runtime and shared mcp tool context as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/resident-runtime.ts`, `src/serve/background-runtime.ts`, `src/mcp/server.ts`, `src/mcp/context.ts`, `test/serve/resident-runtime.test.ts`

### Approach
- Make one runtime own store, watcher, jobs, embedding/rerank/generation lifecycle, and cancellation registry.
- Refactor stdio MCP to consume the same ToolContext/runtime ports while preserving its standalone process behavior and shutdown semantics.
- Expose generation/model/load counters and index generation for later health/performance assertions.

### Investigation targets
**Required** (read before coding):
- `src/serve/background-runtime.ts:88-260`
- `src/serve/context.ts`
- `src/mcp/server.ts:84-200`
- `src/llm/nodeLlamaCpp/lifecycle.ts`

**Optional** (reference as needed):
- `src/core/job-manager.ts`
- `src/serve/watch-service.ts`

### Key context
- One process may host multiple transports; one model/store lifecycle must not mean one shared mutable MCP session.

## Acceptance
- [ ] Serve and stdio fixtures return unchanged tools/resources through the shared context.
- [ ] Runtime counters prove repeated calls reuse warm models and the same store generation.
- [ ] Shutdown closes each owned resource exactly once and leaves standalone stdio behavior compatible.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
