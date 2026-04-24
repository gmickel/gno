# Future code symbol retrieval and navigation

## Problem

GNO's current code retrieval is chunk-based. The near-term AST task (`fn-74-upstream-freshness-and-code-retrieval.4`) will decide whether real tree-sitter AST chunking is worth shipping. If AST chunking proves valuable, the next opportunity is symbol-aware retrieval and navigation: functions, classes, methods, interfaces/types, imports, and source outlines.

This is future work, not a prerequisite for the AST benchmark. A fresh agent should start here only after the AST decision has landed or been explicitly revisited.

## Goals

- Use AST-derived metadata to improve code search, snippets, and navigation.
- Expose source symbols in ways that help CLI, Web UI, MCP, and SDK workflows.
- Keep document/chunk storage stable unless a schema change is justified by benchmark/user value.
- Preserve fallback behavior for unsupported languages and parser failures.

## Non-Goals

- Do not build a full LSP or static-analysis engine.
- Do not require AST parsing for non-code documents.
- Do not ship symbol surfaces without tests and retrieval-quality evidence.

## Key Context

- Current chunker: `src/ingestion/chunker.ts`
- Current ADR: `docs/adr/003-code-aware-chunking.md`
- AST benchmark task: `fn-74-upstream-freshness-and-code-retrieval.4`
- Existing related docs: `docs/guides/code-embeddings.md`, `docs/HOW-SEARCH-WORKS.md`
