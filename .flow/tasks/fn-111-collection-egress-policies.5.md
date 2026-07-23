---
satisfies: [R1, R5, R6, R8]
---
# fn-111-collection-egress-policies.5 Expose policy configuration checks and denials across surfaces

## Description
Deliver expose policy configuration checks and denials across surfaces as one implementation-sized increment.

**Size:** M
**Files:** `src/core/retrieval-trace-management.ts`, `src/cli/commands/collection/policy.ts`, `src/serve/routes/api.ts`, `src/serve/routes/traces.ts`, `src/mcp/tools/status.ts`, `src/mcp/tools/trace.ts`, `src/sdk/client.ts`, `src/serve/public/components/CollectionModelDialog.tsx`, `spec/output-schemas`

### Approach
- Add collection policy get/set/check and explain-egress paths using guarded config mutation, diff, and explicit confirmation for relaxations.
- Expose effective/source policy, decision/reason, partial semantics, and audit controls consistently in CLI/REST/MCP/SDK/Web/Desktop without content leakage.
- Invalidate resident sessions/caches/queued jobs when a policy tightens; re-evaluate at execution time, not enqueue time.
- Gate trace artifact egress at the shared `RetrievalTraceManagementService.export` boundary (or one policy-aware wrapper directly composed by it), preserving `RetrievalTraceExportRequest` / `RetrievalTraceExportResult` and the closed export schema. Local inspection, explicit labels, deletion, and purge remain locally usable and do not become egress operations.
- Keep authorization dimensions orthogonal: bearer gateway authentication identifies a caller but still never enables trace label/export/delete/purge; HTTP MCP trace mutation requires the existing explicit `gateway.enableWrite` / `--mcp-enable-write` control; collection egress policy then independently decides whether an authorized export may target local, LAN, or remote destinations. Denials expose stable content-free policy codes.
- Preserve task-3 surface behavior while adding policy fields: newest-first opaque list pagination, bounded show totals/truncation, append-only explicit labels, aggregate manifest identity, missing-trace `NOT_FOUND`, and physical purge cleanup status all remain unchanged.

### Investigation targets
**Required** (read before coding):
- `src/cli/commands/collection`
- `src/core/config-mutation.ts`
- `src/serve/routes/api.ts`
- `src/sdk/client.ts`
- `src/mcp/tools/status.ts`

**Optional** (reference as needed):
- `src/serve/public/pages/Collections.tsx`
## Acceptance
- [ ] All surfaces share policy values, effective source, stable reason codes, explicit partial semantics, and audit controls.
- [ ] Policy relaxation requires visible explicit action; tightening invalidates/rechecks sessions, caches, and queued transfers.
- [ ] Blocked actions remain locally usable where allowed and return actionable remediation without sensitive data.
- [ ] Policy checks never substitute for trace write authorization, never disable local trace inspection/purge, and never mutate or partially reuse an aggregate export manifest after an egress denial.

<!-- Updated by plan-sync (cross-spec): fn-100-private-retrieval-learning-loop.3 froze trace surface schemas, write authorization, aggregate exports, and local purge behavior -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
