# fn-64-retrieval-quality-and-terminal.2 Harden BM25 query building and ranking semantics from the regression matrix

## Description

Use the new regression suite to tighten lexical retrieval semantics.

This task owns the production BM25 behavior changes:

- query building / escaping behavior for lexical terms
- explicit field weighting decisions for `documents_fts`
- collection-filter planner safety if the current query shape is suboptimal
- any narrow helper changes needed so hyphen/underscore/code-ish terms behave correctly

Lexical grammar boundary to make explicit in this task:

- quoted phrases:
  - supported or rejected intentionally, not accidentally
- negation:
  - supported, rejected, or narrowed intentionally
- hyphen compounds:
  - `real-time`
  - `multi-agent`
  - `gpt-4`
  - `DEC-0054`
- underscore-heavy identifiers:
  - preserved intentionally
- prefix behavior:
  - explicit where it applies and where it does not
- malformed lexical input:
  - stable validation/error behavior, not raw SQLite leakage

Start here:

- `src/store/sqlite/adapter.ts`
- `src/store/migrations/002-documents-fts.ts`
- `src/pipeline/search.ts`
- `docs/HOW-SEARCH-WORKS.md`
- `docs/ARCHITECTURE.md`

Requirements:

- implement only behavior justified by task 1's regression matrix
- do not add new lexical behavior without a failing regression first
- prefer small, explainable lexical rules over broad fuzzy parsing
- document the supported lexical grammar explicitly in code comments/ADR/docs so future changes do not drift
- keep JSON and non-BM25 retrieval semantics stable unless the tests prove a needed change
- avoid planner regressions for collection-filtered FTS paths
- preserve stable `INVALID_INPUT` behavior for malformed lexical input
- preserve adapter contract: `searchFts()` still returns raw BM25 scores for higher-layer normalization

Likely change areas:

- FTS query construction helper(s)
- `bm25(documents_fts, ...)` weighting if explicit weighting is adopted
- query path for collection-filtered FTS lookup
- ranking notes or explain metadata if the semantics change enough to require it
- `src/pipeline/hybrid.ts` only if malformed-input propagation or strong-signal assumptions need alignment

Tests:

- make task 1's new regression cases pass
- extend CLI/integration coverage where the final behavior differs materially from the prior output
- keep or add tests for malformed lexical input so input validation behavior stays intentional
- add at least one filtered-search regression proving no collection-filter planner/correctness regression

ADR/docs/website:

Own these updates in this task:

- add `docs/adr/002-bm25-query-semantics-and-weighting.md`
- update `docs/HOW-SEARCH-WORKS.md`
- update `docs/ARCHITECTURE.md`
- update `docs/CLI.md` if user-facing lexical behavior or explain semantics change
- update `docs/TROUBLESHOOTING.md` with concrete examples when useful
- update `spec/cli.md` if lexical CLI semantics become contractual
- update `docs/API.md` / `docs/MCP.md` if shared search/query semantics change materially beyond CLI-only presentation
- update `README.md` if the result is headline retrieval-quality work
- update `website/features/hybrid-search.md`
- update `website/_data/features.yml`
- run `bun run website:sync-docs`

Related prior work to preserve:

- `fn-18.1`
- `fn-18.2`
- `fn-31-intent-steering-and-rerank-controls.1`
- `fn-40-structured-query-document-syntax.1`

Non-goals:

- per-collection model overrides
- public benchmark CLI work
- code-aware chunking
- terminal hyperlink output

## Acceptance

- [ ] Task 1 regression suite passes against the hardened BM25 implementation.
- [ ] BM25 query construction handles the covered hyphenated and underscore-heavy lexical cases intentionally.
- [ ] Field weighting and collection-filter semantics are explicit in code and docs.
- [ ] Supported lexical grammar boundaries are explicit for quoted phrases, negation, hyphen compounds, underscores, and prefix behavior.
- [ ] Malformed lexical queries still return stable validation errors rather than raw SQLite syntax failures.
- [ ] Collection-filtered lexical search has explicit regression coverage for both correctness and plan/latency safety.
- [ ] Non-lexical retrieval behavior and structured output schemas remain unchanged unless explicitly documented.
- [ ] ADR-002 records the lexical weighting/query semantics decision.
- [ ] Docs and website hybrid-search copy reflect the final behavior.

## Done summary

Implemented BM25 lexical hardening in the SQLite adapter.

Delivered:

- replaced the whitespace-quote FTS helper with a narrow explicit lexical grammar
- added intentional handling for quoted phrases, negation, hyphen/plus compounds, and underscore-heavy identifiers
- preserved stable INVALID_INPUT behavior for malformed lexical input
- switched BM25 scoring to explicit filepath/title/body weights
- moved FTS search to an FTS-first CTE to keep filtered searches predictable
- preserved raw BM25 score semantics for higher-layer normalization
- updated lexical regression tests and CLI-visible fixture tests
- documented the lexical grammar and weighted BM25 behavior in CLI/search/architecture/troubleshooting docs and the CLI spec
- synced website docs and hybrid-search copy

## Evidence

- Commits:
- Tests: bun test test/store/fts-lexical-regression.test.ts test/store/fts.test.ts test/cli/search-fixtures.test.ts, bun run lint, bun run docs:verify, make -C website sync-docs
- PRs:
