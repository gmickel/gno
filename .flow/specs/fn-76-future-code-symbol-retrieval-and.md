# Future code symbol retrieval and navigation

## Problem

GNO's current code retrieval is chunk-based. The AST task (`fn-74-upstream-freshness-and-code-retrieval.4`) rejected production tree-sitter chunking for now: the canonical fixture showed no retrieval-quality gain over heuristic code chunking (`nDCG@10` stayed `0.963`) while adding parser latency and package/install risk.

This is future work, not part of the document graph retrieval foundation. A fresh agent should start here only after new benchmark or user-workflow evidence justifies revisiting symbol metadata.

## Goals

- Use symbol metadata to improve code search, snippets, and navigation only when there is evidence it helps.
- Expose source symbols in ways that help CLI, Web UI, MCP, and SDK workflows.
- Keep document/chunk storage stable unless a schema change is justified by benchmark/user value.
- Preserve fallback behavior for unsupported languages and parser failures.

## Non-Goals

- Do not build a full LSP or static-analysis engine.
- Do not require AST parsing for non-code documents.
- Do not ship symbol surfaces without tests and retrieval-quality evidence.
- Do not add symbol nodes to the document graph until graph consumers can keep document nodes primary and symbol nodes optional/derived.

## Key Context

- Current chunker: `src/ingestion/chunker.ts`
- Current ADR: `docs/adr/003-code-aware-chunking.md`
- Symbol graph decision: `docs/adr/006-code-symbol-graph-foundation.md`
- AST benchmark task: `fn-74-upstream-freshness-and-code-retrieval.4`
- Existing related docs: `docs/guides/code-embeddings.md`, `docs/HOW-SEARCH-WORKS.md`

## Reconsideration Criteria

Reopen implementation only if one of these is true:

- Larger code fixtures show durable nDCG/recall gains from AST or symbol metadata that heuristic chunking cannot match.
- A concrete agent workflow needs exact function/class navigation that current query plus line-range `gno_get`/`gno_multi_get` cannot solve.
- A fallback-safe symbol extractor can run for a small language set without unacceptable install, package, or platform risk.

If implementation proceeds, start with optional derived metadata for TypeScript, TSX, JavaScript, JSX, Python, Go, and Rust. Unsupported languages and parser failures must fall back to current document/chunk retrieval without changing indexing behavior.
