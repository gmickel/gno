# ADR-006: Code-Symbol Graph Foundation

**Status**: deferred
**Date**: 2026-05-09
**Author**: Gordon Mickel

## Context

`fn-79-graph-aware-retrieval-and-agent` added document graph reporting,
traversal tools, confidence metadata, bounded graph-aware retrieval expansion,
and community detection. The remaining question was whether to add code-symbol
nodes to that graph now.

GNO already has a future symbol retrieval epic:
`fn-76-future-code-symbol-retrieval-and`. That epic is explicitly gated on the
AST chunking decision from `fn-74-upstream-freshness-and-code-retrieval.4`.

The AST benchmark decision is now available. The canonical fixture showed no
retrieval-quality gain from tree-sitter chunking over the current heuristic
chunker:

| Mode      | Recall@5 | Recall@10 | nDCG@10 |   MRR | parse ms | chunks | fallbacks |
| --------- | -------: | --------: | ------: | ----: | -------: | -----: | --------: |
| Heuristic |    1.000 |     1.000 |   0.963 | 0.950 |      0.0 |      9 |         0 |
| AST       |    1.000 |     1.000 |   0.963 | 0.950 |     17.1 |      8 |         2 |

The AST path also added parser latency and package/install risk through
tree-sitter WASM grammar assets. Production indexing therefore remains on the
lighter heuristic code-aware chunker.

## Decision

Do not ship code-symbol graph nodes in the document graph now.

Document nodes remain the primary graph nodes. Symbol nodes stay future derived
metadata owned by `fn-76-future-code-symbol-retrieval-and`, not a parallel
schema inside the graph-aware retrieval epic.

## Boundaries For Future Work

Any future code-symbol graph foundation must start as a narrow, optional layer:

- Document nodes remain primary; symbol nodes are derived from indexed
  documents or chunks.
- Supported languages must stay deliberately small. The first candidate set is
  the current code-aware chunker scope: TypeScript, TSX, JavaScript, JSX,
  Python, Go, and Rust.
- Unsupported languages must fall back to current document/chunk retrieval.
- Parser failures must fall back without breaking indexing.
- No full LSP, type checker, cross-file symbol resolver, or all-language static
  analysis engine.
- No MCP, CLI, Web UI, or SDK symbol surface should ship without retrieval or
  navigation evidence.

## Reconsideration Criteria

Reopen symbol graph implementation only when one of these is true:

- Larger code retrieval fixtures show durable quality gains from AST or symbol
  metadata, especially nDCG/recall improvements that heuristic chunking cannot
  match.
- A concrete agent workflow needs exact function/class navigation and cannot be
  solved with current query plus line-range `gno_get`/`gno_multi_get`.
- A fallback-safe symbol extractor can run without adding unacceptable install,
  package, or platform risk.

## Consequences

Graph-aware retrieval remains stable and document-centric. Existing graph
consumers do not need to handle mixed document/symbol node types.

The concrete follow-up is to refine and execute
`fn-76-future-code-symbol-retrieval-and.1` only after new evidence meets the
criteria above.
