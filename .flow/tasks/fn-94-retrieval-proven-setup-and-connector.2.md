---
satisfies: [R3, R4, R6]
---
# fn-94-retrieval-proven-setup-and-connector.2 Add read-only connector verification adapters

## Description
Deliver add read-only connector verification adapters as one implementation-sized increment.

**Size:** M
**Files:** `src/core/connector-verifier.ts`, `src/serve/connectors.ts`, `src/cli/commands/mcp/status.ts`, `test/core/connector-verifier.test.ts`

### Approach
- Define a target capability taxonomy for installed skill and MCP clients instead of treating config-file presence as health.
- Perform normal target status/tool-list plus one read-only scoped search smoke; never modify client config or accept trust/auth prompts.
- Return passed, pending, failed, or unsupported/skipped with target-specific evidence and remediation.

### Investigation targets
**Required** (read before coding):
- `src/serve/connectors.ts:135-260`
- `src/cli/commands/mcp/status.ts`
- `src/cli/commands/mcp/config.ts`
- `src/mcp/server.ts:84-160`

**Optional** (reference as needed):
- `test/serve/connectors.test.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `test/cli/mcp-status.test.ts`

## Acceptance
- [ ] Supported MCP and skill fixtures execute a real read-only search through the installed target path.
- [ ] Unavailable, auth-blocked, and unsupported targets remain truthful pending/failed/skipped states.
- [ ] Verification never changes connector configuration or bypasses a user trust boundary.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
