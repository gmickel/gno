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
Completed cross-surface content-type boost contracts, invalidation, and
configuration behavior.

- Loaded the same normalized content-type rules for BM25 through CLI, REST,
  MCP, SDK, and retrieval replay. Hybrid, Ask, and Capsule continue to consume
  the shared runtime config through their existing dependency boundary.
- Added optional REST and MCP query explain controls without changing normal
  result JSON.
- Added complete bounded content-type boost fields to search explain and query
  diagnose schemas. Diagnose uses v1.2 only when the new component is present,
  preserving v1.0 and affinity-only v1.1 contracts.
- Split the full ranking-config fingerprint from the metadata-derivation
  fingerprint. Search-boost edits now affect live ranking immediately without
  reconverting source content or rebuilding vectors; type, prefix, preset, and
  graph-hint edits still trigger metadata re-derivation.
- Added real CLI/REST/MCP/SDK BM25 parity coverage, boost-only invalidation
  coverage, schema coverage, and MCP input validation.

Verification:

- `bun run lint:check`
- `bun test`
- Focused content boost, diagnose, ingestion, schema, and MCP tests (50 passing)
- `.flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json`

No macOS or Windows client artifacts were awaited, per roadmap execution
policy.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test, bun test ./test/pipeline/diagnose.test.ts ./test/content-type-boost/parity.test.ts ./test/ingestion/sync-tags.test.ts ./test/spec/schemas/query-diagnose.test.ts ./test/mcp/tools/query.test.ts, .flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json
- PRs: