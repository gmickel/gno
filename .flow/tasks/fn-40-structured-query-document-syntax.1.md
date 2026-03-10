# fn-40-structured-query-document-syntax.1 Design and implement first-class structured query documents

## Description

Design and implement first-class multi-line structured query documents using existing GNO naming only: `term`, `intent`, and `hyde`. The result should let a fresh user or agent express advanced retrieval intent in one portable text payload while preserving full compatibility with current `--query-mode` and JSON `queryModes` surfaces.

## Notes For Implementer

- Define the grammar before wiring product surfaces.
- Normalize parsed documents into the same internal structures already used by `queryModes`.
- Keep plain single-line query behavior unchanged.
- Roll out to the first agreed surfaces explicitly and document any phased follow-up.

## Acceptance

- Define the grammar for multi-line structured query documents using `term`, `intent`, and `hyde`.
- Implement parser + validation + normalization into existing internal query-mode structures.
- Wire the syntax into the agreed first surfaces.
- Add docs, examples, and smoke coverage.

## Done summary

Implemented first-class structured multi-line query documents using GNO naming only: `term`, `intent`, and `hyde`. Added a shared parser/normalizer, rolled it through CLI `query`/`ask`, REST `query`/`ask`, MCP `gno_query`, SDK `query`/`ask`, and Web Search/Ask text boxes, then added parser/CLI/API/SDK coverage plus full docs/website updates including a dedicated syntax reference page.

Key decisions:

- structured syntax only activates for multi-line query input, so single-line queries remain unchanged
- plain untyped lines become the base query; if absent, GNO derives the base query from `term:` lines first, then `intent:` lines
- `hyde:` is never searched directly and hyde-only documents are rejected
- explicit `queryModes` and document-derived modes merge, with shared validation across the combined set

## Evidence

- Commits:
- Tests: bun run lint:check, bun test, bun run docs:verify, cd website && mise x -- make build, bun test test/core/structured-query.test.ts test/serve/routes/query.test.ts test/sdk/client.test.ts test/cli/structured-query-document.test.ts --timeout 60000
- PRs:
