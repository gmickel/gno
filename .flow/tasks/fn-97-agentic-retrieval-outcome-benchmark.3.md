---
satisfies: [R2, R3, R5]
---
# fn-97-agentic-retrieval-outcome-benchmark.3 Add product-faithful GNO MCP adapter and instrumentation

## Description
Measure the shipped GNO query/get workflow through its real MCP boundary with exact lifecycle and context instrumentation.

**Size:** M
**Files:** `evals/agentic/adapters/gno-mcp.ts`, `evals/agentic/lifecycle/gno-mcp.ts`, `test/eval/agentic/gno-mcp-adapter.test.ts`, `spec/evals-agentic.md`

### Approach
- Spawn the real isolated stdio MCP server and invoke shipped tool names/schemas; do not import retrieval pipelines or add hidden shortcuts unavailable to an agent.
- Follow the installed skill's search/query then get/multi_get workflow, capturing normalized arguments/order, returned exact evidence coordinates, repeated reads, filters, model-visible bytes, errors, and stop timing.
- Build or reuse the shared GNO-native immutable index from task 1's corpus snapshot during unmeasured preparation; record its fingerprint/build observations. Cold and warm reuse that exact GNO index: cold starts a fresh MCP process/cached model and scores its first call; warm preserves one process/index/model after a discarded readiness probe. Report preparation/startup/model/tool/driver/e2e timings separately with null reasons where unavailable.
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
Implemented the product-faithful GNO stdio MCP benchmark comparator.

- Added exact canonical-to-product tool mapping, task isolation, strict structured-output validation, and exact line-atomic evidence normalization.
- Added isolated offline preparation using production ingestion, a four-model SHA-256 lock, full embedding verification, cold/warm lifecycle behavior, cancellation, and failure-safe cleanup.
- Added fake-process contract/lifecycle/isolation tests, all-24-task runner coverage, and an opt-in real isolated stdio MCP smoke.
- Documented the GNO comparator and the fail-closed pinned qmd comparator methodology.
- Independent quality review verdict: SHIP.
## Evidence
- Commits: ffa374c
- Tests: bun run lint:check, bunx tsc --noEmit, bun test test/eval/agentic, GNO_AGENTIC_RUN_REAL_MCP=1 bun test test/eval/agentic/gno-mcp-real.test.ts --timeout 300000, .flow/bin/flowctl validate --spec fn-97-agentic-retrieval-outcome-benchmark --json
- PRs: