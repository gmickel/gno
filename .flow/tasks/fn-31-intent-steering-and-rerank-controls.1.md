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

Implemented intent steering and rerank controls across retrieval surfaces.

Evidence in code/docs/specs:

- CLI/API/Web/MCP support `intent` and `candidateLimit`
- config supports `models.expandContextSize`
- rerank normalization tests cover intent-aware deduplication behavior
- docs/specs/schemas updated across surfaces

## Evidence

- Commits:
- Tests: test/pipeline/rerank-normalization.test.ts, test/serve/routes/query.test.ts, test/serve/public/retrieval-filters.test.ts, test/sdk/client.test.ts
- PRs:
