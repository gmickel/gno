---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-226-egress-collection-limits-deny-cleanly.1 Implement Egress collection limits deny cleanly instead of failing

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Egress bounds now apply to a request's resolved scope instead of the whole configured collection set. `resolveEgressLineage` validates configured sources without a size bound and throws `EGRESS_SCOPE_LIMIT_EXCEEDED` only when the resolved scope exceeds 128; the shared `resolveCollectionEgressLineage` turns that into the existing `COLLECTION_LIMIT_EXCEEDED` `EgressDeniedError`, which HTTP MCP (403), daemon status, MCP sync/update, the clipper and exports already handle as a denial. Scoped calls with 129+ configured collections are evaluated normally; unscoped calls get the denial. `gno_egress_check` unscoped over 128 returns an explicit VALIDATION message. No bound changed. Docs: CONFIGURATION.md "Collection limits", spec/mcp.md, CHANGELOG. Skill: SKILL.md, mcp-reference.md, cli-reference.md (plus project copies); autoresearch scenario `egress_collection_limit` passes 2/2.

Decision: an unscoped request over 128 is denied without an egress audit receipt, because a receipt needs a lineage, which cannot exceed 128 sources; nothing is transferred.

stage: impl-review - skipped(policy: repo CLAUDE.md "Skip all review stages")

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: b050f80f7f0c7c0c5b9453a45411d053a03ea6e9, a318f49fc9d5fb43d38e2e21e20e43beb7dcc5e5
- Tests: bun test test/egress/collection-limits.test.ts, bun test <105 egress-related files> (1243 pass), bun run docs:verify
- PRs: