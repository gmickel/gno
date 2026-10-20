---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-222-search-vsearch-and-query-across-several.1 Implement Search, vsearch and query across several collections

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Search, vsearch and query accept a collection allowlist on CLI (repeatable -c), MCP (`collections`), REST (`POST /api/search`, `/api/query`) and SDK.

- Shared core resolver (`src/core/collection-scope.ts`): trim/lowercase/dedupe/sort, one bound of 256, rejects `collection` + `collections`, empty and non-string lists; unknown names listed.
- Applied in eligibility SQL before every candidate limit (BM25, vector), plus mirror-hash hydration, graph seeds, and the request hydration cache key (which previously keyed only on `collection`).
- HTTP MCP egress scopes gno_search/gno_vsearch/gno_query to the listed collections.
- Model rule: shared model when listed collections agree, unscoped default otherwise.
- `gno_query_diagnose` / `query --diagnose` stay single-collection; SDK `ask` does not take `collections`.
- `meta.collections` echoed and added to the search-results schema; MCP legacy golden regenerated (only the new input).
- Specs, docs (CLI/MCP/API/SDK), shipped skill and CHANGELOG (crediting @ArnauvGilotra, #313) updated.

stage: impl-review - skipped(config: review backend none; repo rules skip review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 874e3e6638576e147a845d8f00d3b6fc08ae7c2e
- Tests: bun test test/pipeline test/store test/mcp test/sdk test/serve test/egress test/core test/cli/collections-allowlist.test.ts test/cli/search-smoke.test.ts test/spec (3317 pass, 0 fail), bun run lint:check (0 errors, 46 warnings = baseline)
- PRs: