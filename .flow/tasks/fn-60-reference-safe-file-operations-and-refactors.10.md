---
satisfies: [R5, R6]
---
# fn-60-reference-safe-file-operations-and-refactors.10 Adopt canonical refactors in SDK and write-gated MCP

## Description
Adapt SDK and write-gated MCP rename/move operations to the canonical preview/apply service, preserving their operation-specific schemas while proving semantic parity with REST for shared fixtures.

**Size:** M
**Files:** `src/sdk/client.ts`, `src/sdk/types.ts`, `src/mcp/tools/workspace-write.ts`, `spec/mcp.md`, `test/sdk/client.test.ts`, `test/mcp/tools/workspace-write.test.ts`

### Approach
- Expose typed preview/apply results in the SDK without bypassing capabilities or stale-plan checks.
- Keep MCP write/destructive gates and confirmation authoritative at the transport boundary.
- Contract-test success, stale, denied, ambiguous, rollback, and sync-pending outcomes against the same core fixtures.

### Investigation targets
**Required** (read before coding):
- `src/sdk/client.ts:1620-1825` — current SDK operations
- `src/sdk/types.ts` — public SDK contracts
- `src/mcp/tools/workspace-write.ts:161-332` — MCP schemas/gates/handlers
- `spec/mcp.md:1715` — workspace write contract
- `test/sdk/client.test.ts:583-635` — SDK parity fixtures

**Optional** (reference as needed):
- `test/mcp/tools/workspace-write.test.ts` — MCP schema tests
- `test/mcp/tools/workspace-write-export.test.ts` — logical-record refusal

### Key context
MCP annotations are non-authoritative. SDK direct calls must enforce the same document capability and stale-plan semantics as REST/MCP.

## Acceptance
- [ ] SDK and MCP use the canonical planner/executor and expose equivalent plan digests, classifications, terminal states, and recovery metadata.
- [ ] SDK cannot bypass capability, stale-plan, collection-lock, or occupied-target checks.
- [ ] MCP retains write/destructive confirmation gates and refuses apply without the exact confirmed plan.
- [ ] Shared fixtures prove semantic parity with REST without introducing a generic action bus.
- [ ] Focused SDK/MCP contract tests, specs, and lint pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
