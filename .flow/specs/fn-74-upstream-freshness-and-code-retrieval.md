# Upstream freshness and code retrieval quality

## Problem

Recent QMD 2.1.0 work and unreleased main commits surfaced several areas worth validating against GNO instead of assuming parity. GNO already has typed query modes, per-collection models, rerank controls, OSC8 links, indexed URIs, line suffixes, runtime GGUF/GPU/sqlite diagnostics, and BM25 lexical regressions covered.

Remaining high-leverage work is narrower:

- refresh native/runtime dependencies safely
- lock dependency policy down to reduce release surprises
- tighten MCP guidance so agents use GNO's existing retrieval tools better
- evaluate real tree-sitter AST chunking against the current heuristic code-aware chunker using GNO's existing code benchmark

## Goals

- Upgrade `node-llama-cpp` if local smoke, package, and retrieval gates pass.
- Evaluate and upgrade `sqlite-vec` if packaging/runtime smoke passes across supported paths.
- Pin dependency versions exactly where practical and document the policy.
- Improve MCP tool descriptions/guidance for search, query modes, line-range retrieval, and multi-get workflows without changing core capability.
- Benchmark AST-aware tree-sitter chunking against current heuristic code chunking before deciding whether to ship it.
- Add a durable maintenance note so native/runtime freshness is checked routinely.

## Non-Goals

- Do not blindly copy QMD architecture.
- Do not remove GNO's existing structured query mode implementation.
- Do not ship AST chunking without benchmark evidence and fallback behavior.
- Do not add a public `gno bench` command in this epic; that is a separate future epic.

## Key Context

- QMD release inspected: `tobi/qmd` `v2.1.0`, published 2026-04-05.
- QMD unreleased main inspected through 2026-04-22.
- GNO current relevant coverage:
  - `src/ingestion/chunker.ts` heuristic code-aware chunking
  - `docs/adr/003-code-aware-chunking.md`
  - `package.json` benchmark scripts: `bench:code-embeddings`, `bench:general-embeddings`, `eval:retrieval-candidates`
  - `src/mcp/tools/index.ts`, `docs/MCP.md`, `spec/mcp.md`
  - `src/llm/nodeLlamaCpp/*`, `src/store/vector/sqlite-vec.ts`
  - `.github/workflows/*` already use `bun install --frozen-lockfile`

## Delivery Notes

Use separate commits per task where practical. Every dependency bump must include lockfile updates and package/install smoke. Any user-visible behavior or operational policy change must update docs/specs/skills if applicable.

## Suggested Gates

- `bun install --frozen-lockfile`
- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- targeted runtime smoke for changed native deps
- package smoke via `bun run build:css && npm pack` when dependency/package contents change
- code benchmark before/after for AST task
