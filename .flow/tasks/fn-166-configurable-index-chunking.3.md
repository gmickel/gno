---
satisfies: [R5]
---
# fn-166-configurable-index-chunking.3 Chunking readiness across status surfaces

## Description
Expose truthful policy and layout readiness for R5 through the existing shared status payload.

**Size:** M
**Files:** src/store/types.ts, src/store/sqlite/adapter.ts, src/cli/commands/status.ts, src/mcp/tools/status.ts, src/sdk/client.ts, existing REST status projection, spec/output-schemas/status.schema.json, spec/cli.md, spec/mcp.md, test/spec/schemas/status.test.ts, test/fixtures/outputs/status-healthy.json, status tests.
**Touches:** [src/store/**, src/cli/commands/status.ts, src/mcp/tools/status.ts, src/sdk/client.ts, src/serve/**, spec/output-schemas/status.schema.json, spec/cli.md, spec/mcp.md, test/spec/**, test/fixtures/outputs/status-healthy.json, test/cli/**, test/mcp/**, test/sdk/**, test/serve/**]

### Approach
- Extend the existing getStatus options and shared projection rather than computing inconsistent client-specific counts. Derive applied layout state from active document-to-content ownership, configured policy from current config, and preserve fn-161 active-vector backlog semantics.
- Add a documented optional chunking object to structured status with configured params, actual applied policy/mixture, explicit legacy/empty/pending/current semantics and pending mirror/document counts. Keep technical generations internal. Review and finalize the exact schema before implementing the output.
- CLI/MCP human output explains pending rechunking separately from embedding and source-refresh errors. Keep the existing default status text unobtrusive; no new warning for a valid legacy-default index.
- Reading status does not claim a target, backfill markers, or start rebuild work. A config edited since indexing must appear pending even before the next sync claim.

### Investigation targets
**Required:**
- src/store/sqlite/adapter.ts:5690
- src/cli/commands/status.ts
- src/mcp/tools/status.ts
- src/sdk/client.ts:1350
- spec/output-schemas/status.schema.json
**Optional:**
- test/spec/schemas/status.test.ts
- test/mcp/tools/status.test.ts

### Quick commands
Use Bun 1.4.2. Run bun test test/cli/status.test.ts test/mcp/tools/status.test.ts test/spec/schemas/status.test.ts test/sdk; include affected REST status tests. Run lint/typecheck after focused tests.

## Acceptance
- [ ] Schema and actual CLI/MCP/SDK/REST status agree for legacy defaults, empty index, changed config before sync, completed custom policy, and partial/mixed rebuild.
- [ ] Pending counts use active ownership and correctly handle duplicate content, inactive documents, and conversion errors.
- [ ] Status inspection causes no layout or embedding work and cannot clear pending state.
- [ ] Existing embedding readiness and healthy default output retain their meaning; affected contracts/tests pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
