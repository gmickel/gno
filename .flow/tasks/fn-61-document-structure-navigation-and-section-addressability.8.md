---
satisfies: [R4]
---
# fn-61-document-structure-navigation-and-section-addressability.8 Add read-only MCP section resolution and citation evidence

## Description
Add the read-only MCP section-resolution/retrieval contract using the shared target resolver, returning citation-safe document/section/line evidence and explicit non-success states without introducing writes or persistent section identity.

**Size:** M
**Files:** `src/mcp/tools/sections.ts`, `src/mcp/tools/index.ts`, `spec/mcp.md`, `docs/MCP.md`, `test/mcp/tools/sections.test.ts`

### Approach
- Prefer a focused read-only tool or compatible document-retrieval extension with one versioned schema.
- Return canonical URI, heading, current anchor, line range, fingerprint, and resolution status.
- Preserve existing `gno_get` line-range behavior and use shared core fixtures.
- Treat `readOnlyHint` as descriptive metadata; prove the implementation has no write path.

### Investigation targets
**Required** (read before coding):
- `src/mcp/tools/index.ts:109-113` — current document/line retrieval tools
- `spec/mcp.md:1262` — existing target-anchor vocabulary
- `src/mcp/tools/links.ts` — read-only graph/link tool pattern
- `test/mcp/tools/links.test.ts` — read-only MCP contract tests
- `src/core/sections.ts` — shared resolver owner

**Optional** (reference as needed):
- MCP tools specification 2025-11-25
- `docs/MCP.md` — current retrieval workflow

### Key context
No MCP write, target persistence, or parser fork. An ambiguous/stale target cannot produce a definitive cited section.

## Acceptance
- [ ] MCP accepts/returns the shared versioned target and exact/recovered/ambiguous/stale/missing semantics.
- [ ] Navigable results include canonical URI, current anchor, heading, line range, fingerprint, and citation-safe evidence.
- [ ] Ambiguous/stale/missing results cannot be mistaken for successful navigation or definitive citation.
- [ ] Existing `gno_get`/line-range retrieval remains backward compatible and no-write tests pass independent of annotations.
- [ ] MCP schema, contract tests, docs, and lint pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
