---
satisfies: [R1, R2, R4, R5]
---
# fn-108-explainable-content-type-search-boosts.3 Complete cross-surface schemas invalidation and configuration UX

## Description
Deliver complete cross-surface schemas invalidation and configuration ux as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/mcp/tools/query.ts`, `src/sdk/types.ts`, `spec/output-schemas/query-diagnose.schema.json`, `spec/output-schemas/search-results.schema.json`, `test/content-type-boost/parity.test.ts`

### Approach
- Thread effective boost and explain metadata through query/Ask/Capsule, CLI/REST/MCP/SDK without changing normal output shapes.
- Use rule fingerprint invalidation to recompute affected metadata/ranking without unnecessary content conversion or vector rebuild.
- Expose config validation and current effective rules consistently in status/diagnose.

### Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts:3559-3740`
- `src/mcp/tools/query.ts`
- `src/sdk/types.ts`
- `src/config/content-types.ts:128-140`
- `test/spec/schemas`

**Optional** (reference as needed):
- `src/cli/commands/query.ts:259-510`
## Acceptance
- [ ] Equivalent requests produce identical boost/explain components across CLI/REST/MCP/SDK.
- [ ] Rule edits invalidate the effective ranking metadata without unnecessary converter/vector work.
- [ ] Normal outputs remain compatible; optional explain schemas validate all new fields.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
