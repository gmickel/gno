# fn-76-future-code-symbol-retrieval-and.1 Design symbol-aware code retrieval after AST decision

## Description

Design and, if justified, implement symbol-aware code retrieval after the AST chunking decision from `fn-74-upstream-freshness-and-code-retrieval.4` is complete.

Start by reading the AST benchmark results and current chunking implementation. If AST chunking was rejected, this task should either close with the same evidence or define a narrower future criterion. If AST chunking shipped or remains promising, design a minimal symbol metadata path that helps retrieval/navigation without turning GNO into an LSP.

Candidate surfaces:

- chunk metadata for primary symbol name/kind/signature/line
- CLI JSON fields for code results when available
- Web document outline for code files
- MCP guidance/results that let agents retrieve exact function/class ranges
- optional `gno symbols <ref>` or SDK helper only if it earns its keep

## Acceptance

- [ ] Re-anchor on `fn-74-upstream-freshness-and-code-retrieval.4` outcome before any implementation.
- [ ] Identify minimal symbol metadata needed for retrieval/navigation and where it belongs.
- [ ] Decide whether schema/storage changes are necessary; if yes, update `spec/db/schema.sql` and migrations with compatibility notes.
- [ ] Define supported language scope and parser-failure fallback.
- [ ] Add tests for symbol extraction on TS/JS/Python/Go/Rust if implemented.
- [ ] Add retrieval or UX proof that symbol metadata improves a real workflow before exposing broad public API.
- [ ] Update docs/specs/skills if user-facing or MCP-facing surfaces change.
- [ ] Run relevant benchmark/gates before marking done.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
