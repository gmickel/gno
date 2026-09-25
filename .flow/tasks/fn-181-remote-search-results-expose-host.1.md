---
satisfies: [R1, R2, R3]
---
# fn-181-remote-search-results-expose-host.1 Implement Remote search results expose host absolute paths

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Remote callers no longer receive host absolute paths: every `/api/*` JSON response to a caller the `localClient` rule judges remote has its `absPath` fields removed at the route boundary (original-file `/api/doc-asset` bytes exempt), and every Streamable HTTP MCP result and `gno://` resource header drops them, while CLI, stdio MCP, SDK and the same-host Web UI keep them. The inventory lives in docs/API.md "Host Paths and Remote Callers"; schemas, MCP/spec docs, skill, CHANGELOG and gno.sh (branch fn-181-remote-paths, e74480b, unpushed) are updated, and unsynced capture/remember errors now name the file by URI. Contract tests: test/spec/schemas/host-paths.test.ts (local + remote REST /api/search, stdio + HTTP MCP gno_search, doc-asset passthrough).

Follow-up (outside this result-field scope): owner configuration paths (collection root `path`, status `configPath`/`dbPath`) still reach remote REST/HTTP MCP callers.

Tier: session (actual model: claude-opus-5-5)
baseline: green (mise exec bun@1.4.2 -- bun test, 5742 pass pre-edit)

stage: impl-review - ran [round 1 fan-out NEEDS_WORK (doc-asset byte rewrite) .. round 2 SHIP]
## Evidence
- Commits: 63d798fb08bc1d277c085ca050c7ca4f8bd2a43c, c40ce78589ae079c13ab6b5b3213a90818d29935, 49ed6bbfdee5c8f15d8a34210b04bf98eb709466
- Tests: mise exec bun@1.4.2 -- bun test test/spec/schemas/host-paths.test.ts test/serve/public/pages/DocView-actions.dom.test.tsx test/mcp/tools/capture.test.ts, mise exec bun@1.4.2 -- bun test, mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, gno.sh fn-181-remote-paths e74480b: bun run check, bun run typecheck, bun run build
- PRs: