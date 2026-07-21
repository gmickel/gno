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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
