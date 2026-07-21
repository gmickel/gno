---
satisfies: [R1, R5, R6, R8]
---
# fn-111-collection-egress-policies.5 Expose policy configuration checks and denials across surfaces

## Description
Deliver expose policy configuration checks and denials across surfaces as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/commands/collection/policy.ts`, `src/serve/routes/api.ts`, `src/mcp/tools/status.ts`, `src/sdk/client.ts`, `src/serve/public/components/CollectionModelDialog.tsx`, `spec/output-schemas`

### Approach
- Add collection policy get/set/check and explain-egress paths using guarded config mutation, diff, and explicit confirmation for relaxations.
- Expose effective/source policy, decision/reason, partial semantics, and audit controls consistently in CLI/REST/MCP/SDK/Web/Desktop without content leakage.
- Invalidate resident sessions/caches/queued jobs when a policy tightens; re-evaluate at execution time, not enqueue time.

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


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
