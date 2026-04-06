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
