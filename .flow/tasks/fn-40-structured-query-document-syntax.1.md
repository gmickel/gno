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

TBD

## Evidence

- Commits:
- Tests:
- PRs:
