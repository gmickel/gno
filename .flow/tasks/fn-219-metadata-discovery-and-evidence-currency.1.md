---
satisfies: [R1, R2, R3, R4]
---
# fn-219-metadata-discovery-and-evidence-currency.1 Implement Metadata discovery and evidence currency

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Metadata discovery (`gno metadata`, MCP `gno_list_metadata`, REST `/api/metadata`, SDK `listMetadata`); superseded memory facts marked with `supersededBy` across search, get, ask and Capsules (index-aware, full chain, text marks, Capsule verification reports `superseded` and fails closed on lookup error); verified ask rejects any misquote (`quote_not_in_evidence`). Sol review round 1 NEEDS_WORK (6 findings, all fixed in 9fb0dbba), re-review SHIP.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: e5deb727, 5a421a15, be2667ca, b5d7f637, 9fb0dbba
- Tests: bun test test/core test/pipeline test/cli test/mcp test/sdk test/spec test/store test/serve, bun run lint:check
- PRs: