---
satisfies: [R1, R2, R4]
---
# fn-60-reference-safe-file-operations-and-refactors.6 Implement parser-backed reference impact planning

## Description
Build the parser-backed reference impact planner for rename and same-collection move. It must enumerate examined references, emit minimal rewrite spans only for uniquely resolved targets, and keep opaque or ambiguous syntax unchanged with explicit diagnostics.

**Size:** M
**Files:** `src/core/file-refactors.ts`, `src/core/links.ts`, `src/store/sqlite/adapter.ts`, `test/core/file-refactors.test.ts`, `test/store/links.test.ts`

### Approach
- Reuse GNO's parsed link model and indexed resolution rather than scanning with regexes.
- Resolve the moved note first, then compute each referring document's destination independently.
- Preserve all non-target token bytes and return deterministic classifications/order.

### Investigation targets
**Required** (read before coding):
- `src/core/links.ts` — source parser and link kinds
- `src/store/sqlite/graph-link-resolver.ts` — existing target resolution rules
- `src/store/sqlite/adapter.ts` — link inventory/query access
- `src/core/file-refactors.ts` — extension point and compatibility types
- `test/store/links.test.ts` — resolution and backlink fixtures

**Optional** (reference as needed):
- `test/ingestion/sync-links.test.ts` — indexed link refresh behavior
- `test/serve/api-links.test.ts` — external link result expectations

### Key context
Reference-style Markdown edits occur at definitions. Relative links are recomputed from the referring file. Unsupported Obsidian/plugin syntax remains byte-identical and reported.

## Acceptance
- [ ] Planner reports every examined parsed incoming reference exactly once with a deterministic classification and reason.
- [ ] Unique wiki and Markdown references receive minimal replacement spans preserving aliases, labels, titles, fragments, queries, escapes, and encoding.
- [ ] Ambiguous, malformed, external, HTML, code, and unsupported references remain unchanged and visible in the plan.
- [ ] Repeated runs over unchanged inputs produce the same plan digest and ordered output.
- [ ] Unit/store regression matrix and lint checks pass.


## Done summary
Implemented a bounded, deterministic parser-backed rename/move impact planner. It resolves complete bounded catalogs without first-match ambiguity, inventories self-links and conservative opaque/code/HTML/embed forms, preserves exact destination spans and encoding, respects document edit capabilities, and fails closed for unsafe paths, missing content, truncation, overlap, ambiguity, or unsupported references.
## Evidence
- Commits: be627631
- Tests: bun test test/core/file-refactor-impact.test.ts test/core/file-refactor-planner.test.ts (21 pass), bun test test/core/links.test.ts (54 pass), bun test test/store/links.test.ts (42 pass), bun run lint:check
- PRs: