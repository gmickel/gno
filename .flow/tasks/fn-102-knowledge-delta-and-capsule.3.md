---
satisfies: [R2, R3, R6]
---
# fn-102-knowledge-delta-and-capsule.3 Expose changes diff and impact through shared read surfaces

## Description
Deliver expose changes diff and impact through shared read surfaces as one implementation-sized increment.

**Size:** M
**Files:** `src/core/knowledge-delta.ts`, `src/cli/commands/changes.ts`, `src/serve/routes/api.ts`, `src/mcp/tools/changes.ts`, `src/sdk/client.ts`, `test/changes/cross-surface.test.ts`

### Approach
- Implement list/changes, document diff, and bounded impact services over the journal and existing graph/backlink traversal.
- Return stable cursor and truncation semantics; disclose unavailable prior structural history through the journal delta rather than inventing a persisted `history-unavailable` state, and include evidence paths that explain why a dependent item is impacted.
<!-- Updated by plan-sync: fn-102-knowledge-delta-and-capsule.2 records unavailable prior mirror history as `structureDelta.truncated`, not a persisted `history-unavailable` state -->
- Expose equivalent CLI, REST, MCP, and SDK contracts with readable summaries.

### Investigation targets
**Required** (read before coding):
- `src/core/graph-query.ts:52-110`
- `src/core/graph-analysis.ts`
- `src/cli/program.ts`
- `src/serve/routes/graph.ts`
- `src/sdk/client.ts`

**Optional** (reference as needed):
- `src/core/links.ts`
## Acceptance
- [ ] Changes/diff/impact schemas and parity fixtures agree across all read surfaces.
- [ ] Impact traversal remains depth/node/edge bounded, cycle-safe, and hub-safe with explicit truncation.
- [ ] Expired/purged history and unavailable old content return stable disclosed states.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
