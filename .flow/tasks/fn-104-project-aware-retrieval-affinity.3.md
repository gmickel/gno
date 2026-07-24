---
satisfies: [R3, R4, R5]
---
# fn-104-project-aware-retrieval-affinity.3 Expose explicit affinity inputs across CLI SDK REST and MCP

## Description
Deliver expose explicit affinity inputs across cli sdk rest and mcp as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/options.ts`, `src/sdk/types.ts`, `src/serve/routes/api.ts`, `src/mcp/tools/search.ts`, `test/project-affinity/parity.test.ts`

### Approach
- Enable CLI-local cwd/repo affinity by default with disable/explicit-root controls.
- Add caller-supplied project hints to SDK/REST/MCP without server-side cwd inference, realpath probing, or absolute-path reflection.
- Thread one normalized option contract through search, query, Ask, diagnose, and Capsule requests.

### Investigation targets
**Required** (read before coding):
- `src/cli/program.ts:282-900`
- `src/cli/options.ts`
- `src/serve/routes/api.ts:156-226`
- `src/mcp/tools/search.ts`
- `src/sdk/types.ts`

**Optional** (reference as needed):
- `src/mcp/tools/query.ts`
## Acceptance
- [ ] CLI default/disable/override and SDK/REST/MCP explicit-hint semantics are tested and documented.
- [ ] All surfaces produce the same normalized affinity metadata and ranking for equivalent trusted input.
- [ ] Remote inputs cannot infer server paths or leak unredacted absolute roots.


## Done summary
Implemented one shared project-affinity surface boundary and wired trusted CLI roots plus opaque SDK/REST/MCP hints through search, vsearch, query/diagnose, Ask, and Context Capsule retrieval. Added bounded normalization/privacy/parity coverage at real CLI, SDK, REST, and MCP seams; centralized SDK validation-error translation; exported the public SDK hint/search option types; and updated CLI/MCP interface contracts without changing output schema versions.
## Evidence
- Commits: 97426c9
- Tests: baseline: green (bun test test/core/project-affinity* test/pipeline/project-affinity*: 16 pass, 0 fail), bun run typecheck, bun test test/project-affinity/parity.test.ts test/core/project-affinity.test.ts test/pipeline/project-affinity.test.ts test/cli/search-smoke.test.ts test/cli/query-smoke.test.ts test/cli/ask-smoke.test.ts test/cli/context-capsule.test.ts test/mcp/tools/search.test.ts test/mcp/tools/query.test.ts test/mcp/tools/ask.test.ts test/mcp/context-transport.test.ts test/serve/routes/query.test.ts test/serve/routes/retrieval-context.test.ts test/sdk/client.test.ts (160 pass, 0 fail), post-review: bun test test/project-affinity/parity.test.ts test/sdk/client.test.ts test/serve/routes/query.test.ts test/mcp/tools/search.test.ts test/pipeline/verified-ask-build.test.ts (85 pass, 0 fail), fresh independent rereview: SHIP, bun test (2893 pass, 1 Windows-only skip, 0 fail across 360 files), bun run lint:check, .flow/bin/flowctl validate --spec fn-104-project-aware-retrieval-affinity --json, git diff --check
- PRs: