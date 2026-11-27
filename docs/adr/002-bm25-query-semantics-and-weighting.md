# ADR-002: BM25 Query Semantics and Weighting

**Status**: accepted
**Date**: 2026-04-06
**Author**: Gordon Mickel

## Context

GNO's BM25 path had drifted into an awkward middle state:

- document-level FTS was strong in principle
- docs described intentional lexical behavior
- implementation still relied on simple whitespace quoting and implicit equal weighting

That mismatch made technical queries fragile, especially for:

- hyphenated compounds such as `real-time`, `gpt-4`, and `DEC-0054`
- underscore-heavy identifiers such as `snake_case`
- path/title-oriented lookups where body-only mentions could outrank the expected result
- collection-filtered FTS paths where planner behavior could become surprising

The goal of this ADR is to make BM25 lexical behavior explicit, testable, and stable.

## Decision

Adopt a **narrow explicit lexical grammar** for BM25 search and pair it with **explicit weighted BM25 scoring**.

### Lexical grammar

GNO BM25 search supports:

- plain lexical terms
- quoted phrases
- negation, only when at least one positive term exists
- intentional handling for hyphenated technical compounds
- underscore-preserving identifier lookups

GNO BM25 search does **not** attempt to become a broad custom query language.

The rule is:

- only grammar needed to support tested technical/documentation lookups is included
- any new lexical behavior must arrive with a failing regression first

Malformed lexical input must return stable validation-style behavior instead of leaking raw SQLite syntax failures.

### Weighted BM25 fields

`documents_fts` has three user-meaningful lexical columns:

- filepath
- title
- body

These fields are weighted intentionally rather than left to equal defaults.

Decision:

- title hits should win first for targeted doc lookups
- filepath hits should beat weak body-only mentions for path-oriented queries
- body remains the broad recall surface, but not the only ranking signal

### Name-match boost

Column weights alone (`filepath: 1.5`, `title: 4.0`, `body: 1.0`) were not enough to make a document whose title or filename is the query rank first when dozens of other documents repeat those words in their bodies. Raising the column weights high enough to compete with dense body term-frequency still topped out around 75% on name lookups while flattening ordinary body ranking, so `FTS5_FIELD_WEIGHTS` stay unchanged.

Instead, keyword search (`gno search`) and the BM25 leg of hybrid search (`gno query`) opt into a coverage-based name-match boost inside `SqliteAdapter.searchFts` (internal callers such as managed memory remember/recall and activation probes leave it off):

- **Single-scan candidate union**: one materialized FTS scan computes both normal BM25 (`score`) and title/filepath-only BM25 (`name_score`, body weight `0.0`), then unions the top `limit` normal rows with up to 50 eligible rows where `name_score < 0`. Eligibility filters apply inside the scan, so ineligible name hits cannot consume slots.
- **Name coverage**: distinct positive query terms (expanding quoted phrases and hyphenated compounds, excluding negated terms) are compared against lowercased alphanumeric tokens of the document title and of the filename stem (the last path segment without its extension; directory names do not count), taking the larger multiplier. Terms of 3+ characters may prefix-match name tokens; 1–2 character terms require exact equality. Query coverage is `q = matchedTerms / terms.length` and name coverage is `n = min(matchedName, matchedTerms) / nameTokens.length` so repeated words in a title cannot inflate coverage.
- **Multiplier on raw BM25**: a full match (`q == 1 && n == 1`) multiplies the raw negative BM25 score by `3`; a subset match where all query terms appear in the name or all name tokens appear in the query (`q == 1 || n == 1`) multiplies by `1 + (q * n)^2`; partial overlaps leave the score unchanged.
- **Floor and cut**: `minRelativeScore` keeps computing its floor from the best unboosted score before re-sorting by adjusted score and cutting to `limit`.

### Filtered FTS query shape

Collection-filtered lexical search must use an FTS-first query shape so SQLite does not regress into poor planner choices.

Decision:

- run FTS first
- then join/filter the matched documents
- keep this explicit in code rather than relying on planner luck

## Consequences

### Positive

- technical lexical queries behave intentionally instead of accidentally
- docs can describe BM25 semantics truthfully
- regression coverage protects future changes
- collection-filtered lexical search becomes more predictable

### Negative

- grammar is more complex than raw whitespace quoting
- explicit weighting requires judgment and may need retuning
- a narrow grammar means some “advanced query” wishes remain unsupported by design

## Rejected Alternatives

### 1. Keep simple whitespace quoting and just patch edge cases ad hoc

Rejected because it preserves the doc/implementation mismatch and makes future regressions likely.

### 2. Build a much richer lexical query language

Rejected because it would expand scope beyond what GNO needs for reliable retrieval and would create a second language for users to learn.

### 3. Leave field weighting implicit

Rejected because filepath/title/body ranking policy is a product decision, not something to leave accidental.

## Guardrails

- task `.1` regression matrix is the source of truth for protected BM25 cases
- task `.2` may only ship behavior justified by those regressions
- non-lexical retrieval paths should remain unchanged unless explicitly documented

## Related Work

- `fn-64-retrieval-quality-and-terminal.1`
- `fn-64-retrieval-quality-and-terminal.2`
- `fn-18.1`
- `fn-18.2`
- `fn-31-intent-steering-and-rerank-controls.1`
- `fn-40-structured-query-document-syntax.1`
