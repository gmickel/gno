# Intent steering and rerank controls

## Goal

Improve ambiguous-query retrieval quality and give operators tighter control over rerank cost and expansion stability without changing the default happy path.

## Scope

- Add an explicit optional intent field to retrieval surfaces.
- Make intent steer retrieval stages without acting as a standalone search query.
- Expose rerank candidate limits where hybrid retrieval is used.
- Bound expansion generation context size with config support.
- Reduce rerank overhead when multiple documents select identical chunk text.

## Requirements

- CLI: `query` and `ask` support `--intent` and `--candidate-limit`; `search` may support `--intent` if snippet steering is implemented there.
- API: `/api/query` and `/api/ask` accept `intent` and `candidateLimit`.
- Web: Search and Ask advanced controls expose intent and candidate limit where appropriate.
- MCP: query/ask-adjacent retrieval tools expose intent and candidate limit consistently.
- Pipeline: intent bypasses strong-signal shortcut, influences expansion prompts, rerank query composition, and snippet/chunk selection heuristics.
- Config: `models.expandContextSize` supported with sane default and docs.
- Performance: rerank path deduplicates identical texts before scoring and fans scores back out deterministically.
- Docs/spec/tests/evals updated.

## Acceptance

- Ambiguous query with intent returns measurably different top results than the same query without intent in regression tests.
- Candidate limit lowers rerank fan-in without breaking output contracts.
- Expansion generation uses configured bounded context size.
- Full test suite, eval suite, and CLI/API smoke checks pass.
