# fn-74-upstream-freshness-and-code-retrieval.4 Benchmark real AST chunking against heuristic chunking

## Description

Benchmark real tree-sitter AST chunking against GNO's current heuristic code-aware chunking before deciding whether to ship AST chunking.

Current GNO state:

- `docs/adr/003-code-aware-chunking.md` accepted heuristic structural chunking as a narrow automatic first pass.
- `src/ingestion/chunker.ts` detects code extensions and uses regex structural breakpoints.
- Existing benchmark scripts include `bench:code-embeddings` and code embedding fixtures.

QMD 2.1 added `web-tree-sitter` with grammars for TypeScript/TSX/JavaScript/Python/Go/Rust. Use that as inspiration only. The GNO decision must be based on benchmark results, package cost, cross-platform install risk, and fallback behavior.

## Acceptance

- [ ] Build an experiment path that can run current heuristic chunking and AST/tree-sitter chunking on the same code benchmark fixture without permanently changing production behavior first.
- [ ] Benchmark both modes using GNO's existing code benchmark fixture(s); record retrieval quality metrics and latency/indexing cost.
- [ ] Compare package/install impact of `web-tree-sitter` plus grammar packages or bundled WASM assets.
- [ ] Verify supported language scope: TS, TSX, JS, JSX, Python, Go, Rust; document unsupported fallback behavior.
- [ ] Decide whether AST chunking should ship, remain behind an internal/experimental flag, or be rejected for now.
- [ ] If shipping: implement fallback-safe AST chunking, update `doctor/status` visibility, docs, tests, and package file list as needed.
- [ ] If not shipping: update ADR/task summary with benchmark evidence and concrete future criteria.
- [ ] Tests cover parse failure fallback, unsupported extension fallback, stable line/pos metadata, large-function splitting, and no regression for markdown/prose chunking.
- [ ] Run benchmark before/after and full gate as appropriate.

## Done summary
Added a real tree-sitter AST chunking benchmark harness, tests, and recorded benchmark artifacts. The canonical fixture showed no retrieval gain over heuristic chunking, so AST chunking is documented as rejected for production for now.
## Evidence
- Commits:
- Tests:
- PRs: