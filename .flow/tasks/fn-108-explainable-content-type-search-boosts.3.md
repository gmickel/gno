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
- Added optional query and Ask explain controls through CLI, REST, MCP, and SDK
  without changing normal result JSON. Verified Ask carries the same explain
  component while its canonical Capsule bytes remain unchanged.
- Added complete bounded content-type boost fields to search explain and query
  diagnose schemas. Diagnose uses v1.2 only when the new component is present,
  preserving v1.0 and affinity-only v1.1 contracts.
- Split the full ranking-config fingerprint from the metadata-derivation
  fingerprint. Search-boost edits now affect live ranking immediately without
  reconverting source content or rebuilding vectors; type, prefix, preset, and
  graph-hint edits still trigger metadata re-derivation.
- Refreshed hybrid planner ranks after final boost ordering so Capsule evidence
  selection cannot restore stale pre-boost order.
- Added a redacted `contentTypeBoost` status projection across CLI, REST, MCP,
  and SDK with rule IDs, effective factors, and the full ranking fingerprint;
  path prefixes remain private.
- Added real CLI/REST/MCP/SDK BM25, verified-Ask, and status parity coverage,
  boost-only invalidation coverage, schema coverage, and MCP input validation.
- Canonicalized optional config fields before Capsule config fingerprinting so
  valid normalized rules with absent optional fields remain deterministic.

Verification:

- `bun run lint:check`
- `bun test`
- Focused cross-surface, status, Ask, Capsule, hybrid, schema, and boost tests
  (117 passing before the final status additions; all focused tests green)
- `.flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json`

No macOS or Windows client artifacts were awaited, per roadmap execution
policy.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test, bun test ./test/cli/status.test.ts ./test/mcp/tools/status.test.ts ./test/serve/api-status.test.ts ./test/sdk/client.test.ts ./test/spec/schemas/status.test.ts ./test/pipeline/verified-ask-parity.test.ts ./test/pipeline/verified-ask-build.test.ts ./test/pipeline/hybrid-doc-lookup.test.ts ./test/content-type-boost/parity.test.ts, .flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json
- PRs: