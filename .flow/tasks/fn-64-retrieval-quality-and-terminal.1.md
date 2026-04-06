# fn-64-retrieval-quality-and-terminal.1 Add BM25 regression suite for lexical edge cases and ranking stability

## Description

Create the retrieval safety net before changing lexical behavior.

This task should define the regression matrix that later BM25 work must satisfy.

Focus areas:

- hyphenated lexical terms:
  - `real-time`
  - `multi-agent`
  - `gpt-4`
  - `DEC-0054`
- underscore-heavy identifiers:
  - `snake_case`
  - mixed code/search identifiers
- title vs body vs filepath ranking expectations
- collection-filter behavior on FTS queries
- exact-hit stability for common code/doc lookup cases
- malformed lexical input handling:
  - unmatched quotes
  - bad FTS syntax
  - stable validation/error behavior instead of raw SQLite leakage

Start here:

- `src/store/sqlite/adapter.ts`
- `src/pipeline/search.ts`
- `test/store/fts.test.ts`
- `test/cli/search-fixtures.test.ts`
- `spec/evals.md`

Scope:

- add focused regression tests near the storage/search layer
- add at least one higher-level integration test proving expected CLI/query behavior
- add or refine deterministic fixtures so failures name the lexical/path case clearly
- document the regression matrix in `spec/evals.md`
- assert ranking/order where relevant, not just result presence

Suggested test surfaces:

- `test/store/fts.test.ts`
- new focused test file if existing coverage gets noisy:
  - `test/store/fts-lexical-regression.test.ts`
  - or `test/pipeline/bm25-regression.test.ts`
- `test/cli/search-fixtures.test.ts`

Concrete regression cases to encode:

- `real-time` finds docs containing the compound form without requiring manual de-hyphenation
- `DEC-0054` finds the intended identifier hit
- `gpt-4` finds the intended versioned token rather than generic `gpt` noise
- `multi-agent` matches the phrase/compound form intentionally
- `snake_case` remains searchable as written
- title-hit outranks weak incidental body-hit for the same query
- filepath-hit outranks weak body-only mention for path-oriented lookups
- collection-filtered search preserves the intended hit set and ordering
- strong exact lexical hit remains stable in user-visible `search` results
- malformed lexical input yields stable validation behavior

Requirements:

- every test case should encode intended behavior, not just current behavior
- fixtures should be small and purpose-built
- include at least one negative assertion so hardening cannot “fix” one case by over-broad matching another
- keep test naming explicit enough that a future failure explains the lexical rule that broke
- separate storage-layer coverage from at least one CLI/user-visible coverage path so SQL-only changes cannot silently drift from terminal behavior

Docs/spec updates:

- update `spec/evals.md` with the new lexical regression matrix and how it should be run/extended
- if needed, add a short note in `docs/TROUBLESHOOTING.md` about the edge cases under test

Non-goals:

- changing production BM25 logic in this task
- adding code-aware chunking
- adding terminal hyperlinks

## Acceptance

- [ ] BM25 lexical regression cases exist for hyphens, underscores, path/title/body weighting expectations, and collection filtering.
- [ ] Ranking-sensitive cases assert ordering, not just presence.
- [ ] At least one higher-level test covers user-visible retrieval behavior, not just internal helper output.
- [ ] Malformed lexical input is covered and expected validation/error behavior is explicit.
- [ ] Fixtures are deterministic and named for the behavior they protect.
- [ ] `spec/evals.md` documents the regression matrix and extension guidance.

## Done summary
Added a focused BM25 lexical regression matrix before any behavior changes.

Delivered:
- new focused store-level regression coverage for hyphenated compounds, digit-hyphen identifiers, underscore-heavy identifiers, title/body ranking, filepath/body ranking, collection-filter stability, and malformed lexical input stability
- fixture-backed CLI smoke coverage for user-visible hyphen/underscore behavior and unmatched-quote stability
- a new `Lexical Regression Matrix` section in `spec/evals.md`

This task intentionally did not change production BM25 semantics; it only locked expectations in tests/specs.
## Evidence
- Commits:
- Tests: bun test test/store/fts-lexical-regression.test.ts test/cli/search-fixtures.test.ts, bun run lint:check
- PRs: