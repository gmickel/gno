# fn-31-intent-steering-and-rerank-controls.1 Implement intent-aware retrieval steering and rerank controls

## Description

TBD

## Acceptance

- Add explicit `intent` support to hybrid retrieval surfaces and pass it through CLI, API, Web, and MCP.
- Add `candidateLimit` control for hybrid retrieval and ask flows.
- Intent steers expansion, strong-signal bypass, chunk/snippet selection, and reranking without acting as its own query.
- Expansion context size becomes configurable via model config with a stable default.
- Rerank deduplicates identical texts before scoring and preserves deterministic score fan-out.
- Tests cover pipeline behavior, validation, CLI/API/MCP integration, and web filter/state handling.
- Docs, changelog, and release metadata updated.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
