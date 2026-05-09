# fn-76-future-code-symbol-retrieval-and.1 Design symbol-aware code retrieval after AST decision

## Description

Design and, if justified, implement symbol-aware code retrieval after the AST chunking decision from `fn-74-upstream-freshness-and-code-retrieval.4` is complete.

Current decision context: AST chunking was rejected for production in `fn-74-upstream-freshness-and-code-retrieval.4`; the canonical fixture showed no retrieval-quality gain over heuristic chunking (`nDCG@10` stayed `0.963`) and added parser/package risk. `docs/adr/006-code-symbol-graph-foundation.md` therefore keeps code-symbol graph work deferred until stronger benchmark or workflow evidence exists.

Start by reading the AST benchmark results, `docs/adr/006-code-symbol-graph-foundation.md`, and current chunking implementation. If no new evidence exists, close this task with the same deferred decision. If new evidence exists, design a minimal optional symbol metadata path that helps retrieval/navigation without turning GNO into an LSP.

Candidate surfaces:

- chunk metadata for primary symbol name/kind/signature/line
- CLI JSON fields for code results when available
- Web document outline for code files
- MCP guidance/results that let agents retrieve exact function/class ranges
- optional `gno symbols <ref>` or SDK helper only if it earns its keep
- optional derived graph symbol nodes only if document graph consumers keep document nodes primary

## Acceptance

- [ ] Re-anchor on `fn-74-upstream-freshness-and-code-retrieval.4` outcome before any implementation.
- [ ] Re-anchor on `docs/adr/006-code-symbol-graph-foundation.md` and explain what new evidence changed.
- [ ] Identify minimal symbol metadata needed for retrieval/navigation and where it belongs.
- [ ] Decide whether schema/storage changes are necessary; if yes, update `spec/db/schema.sql` and migrations with compatibility notes.
- [ ] Define supported language scope and parser-failure fallback; default candidate scope is TypeScript, TSX, JavaScript, JSX, Python, Go, and Rust.
- [ ] Add tests for symbol extraction on TS/JS/Python/Go/Rust if implemented.
- [ ] Add retrieval or UX proof that symbol metadata improves a real workflow before exposing broad public API.
- [ ] Preserve document nodes as the primary graph nodes if any graph symbol metadata is exposed.
- [ ] Update docs/specs/skills if user-facing or MCP-facing surfaces change.
- [ ] Run relevant benchmark/gates before marking done.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
