---
satisfies: [R1, R5, R6, R7]
---
# fn-98-context-capsule-mvp.6 Complete REST MCP parity promotion proof and documentation

## Description
Deliver complete rest mcp parity promotion proof and documentation as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/serve/server.ts`, `src/mcp/tools/context.ts`, `src/mcp/server.ts`, `test/context/cross-surface-parity.test.ts`, `docs`

### Approach
- Add `POST /api/context`, verification route, and `gno_context` MCP tool over the shared ports; do not fork compiler behavior.
- Run cross-surface canonical parity, adversarial injection, and fn-97 promotion fixtures, then publish the before/after demonstration.
- Update specs, schemas, docs, skill recipes, hosted gno.sh content, and autoresearch skill results in the same finalization task.

### Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts:3257-3820`
- `src/serve/server.ts:200-330`
- `src/mcp/server.ts:84-200`
- `src/mcp/tools/query.ts`
- `test/spec/schemas`

**Optional** (reference as needed):
- `docs/MCP.md`
### Key context
- Raw retrieval tools remain available; the Capsule is an additive evidence primitive.
- A promotion failure blocks product claims and requires revisiting selection/budget rules, not relaxing benchmark gates.

## Acceptance
- [ ] CLI/REST/MCP/SDK parity fixtures compare byte-identical canonical payloads.
- [ ] All fn-97 promotion gates pass and raw receipts/methodology are committed.
- [ ] Specs/docs/skill/gno.sh explain budget, gaps, exact spans, verification, prompt boundaries, and non-persistence accurately.
- [ ] Full prerelease and skill autoresearch gates pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
