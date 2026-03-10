# Structured query document syntax

## Goal

Add a first-class multi-line query document syntax to GNO so advanced retrieval control can be expressed directly in the query payload, not only via repeated flags or structured JSON arrays.

## Why this matters

GNO already supports the underlying retrieval controls:

- `--query-mode term:...`
- `--query-mode intent:...`
- `--query-mode hyde:...`
- `--intent`
- `--exclude`
- `--candidate-limit`

What is still missing is a single user-facing syntax where the query itself can be a structured document such as:

```text
term: exact lexical constraint
intent: semantic disambiguation
hyde: hypothetical passage
```

using GNO naming, not alternative labels.

## Start Here

A fresh agent should be able to execute this epic cold in this order:

1. define the exact document grammar using `term`, `intent`, and `hyde`
2. decide where the syntax is accepted (CLI, API, MCP, Web, SDK)
3. implement parser + validation + normalization
4. map parsed documents onto the existing retrieval controls
5. add docs/examples and compatibility notes

## Non-goals

- Do not rename existing `queryModes` concepts.
- Do not remove current flag- and JSON-based surfaces.
- Do not introduce alternative prefixes like `lex:` or `vec:`.

## Proposed syntax direction

Use existing GNO naming only:

- `term:` for lexical/BM25-oriented entries
- `intent:` for semantic/disambiguation entries
- `hyde:` for a hypothetical passage

Likely rules:

- one typed entry per line
- blank lines ignored
- duplicate `hyde` rejected
- plain single-line query remains valid and unchanged
- structured document may contain multiple `term:` / `intent:` lines and at most one `hyde:` line

## Required product surfaces

This epic should decide and document which surfaces accept the syntax first.

Minimum expectation:

- CLI `query` and `ask`
- API query endpoints where query text currently enters
- MCP if it already mirrors query semantics closely

The implementation may phase rollout, but the spec must make the intended rollout explicit.

## Compatibility requirements

- Existing `--query-mode` and JSON `queryModes` remain supported.
- Structured query documents must normalize into the same internal representation as `queryModes`.
- Existing plain single-line queries remain unchanged.

## Testing requirements

Must include:

- parser unit tests
- duplicate `hyde` validation tests
- compatibility tests proving document syntax and current `queryModes` map to the same internal representation
- at least one CLI/API smoke test using the document syntax

## Docs and website requirements

This epic must include docs and website updates.

Minimum docs:

- README examples
- CLI docs
- API docs
- MCP docs if applicable
- syntax reference page or equivalent doc section
- website/docs navigation updates if syntax becomes a first-class concept

## Complexity assessment

Estimated complexity: medium.

Why medium instead of small:

- parsing itself is easy
- compatibility across CLI/API/MCP/Web is the real work
- docs and migration/ergonomics matter more than parser code

## Expected gain

Primary gain: UX and composability.

What improves:

- easier advanced retrieval prompts for humans and agents
- one portable syntax across surfaces
- easier saved queries / reusable research prompts
- lower friction than repeated flags or JSON payloads

What does not improve by itself:

- retrieval quality directly
- model accuracy directly

So this is a high-ergonomics feature, not a direct relevance breakthrough.

## Deliverables

- grammar/spec
- parser/normalizer
- surface integration plan and implementation
- tests
- full docs/website update

## Acceptance

- Structured query document syntax exists using `term`, `intent`, and `hyde` only.
- Parsed documents normalize into current internal query-mode structures.
- Existing flag/JSON surfaces remain valid.
- Docs and examples are good enough that a fresh user can use the syntax without reading source.
