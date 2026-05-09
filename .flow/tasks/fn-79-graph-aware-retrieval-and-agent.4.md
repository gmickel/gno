# Bounded graph-aware retrieval expansion in gno_query

## Description

Use graph structure as a retrieval adjunct inside `gno_query`: retrieve candidates first, expand bounded one-hop or policy-driven graph neighbors, then score/rerank the combined candidate set without replacing the existing hybrid pipeline.

The behavior must degrade to current retrieval when graph data, embeddings, or similarity edges are unavailable. Expansion should prefer explicit links over inferred/similar edges and must expose enough explain/debug output to understand when graph expansion changed the candidate set.

Docs, Web UI updates when affected, and hosted website updates are part of this task, including search docs, MCP docs, and `~/work/gno.sh` website content.

## Implementation Notes

Start from `src/pipeline/hybrid.ts`, `src/mcp/tools/query.ts`, `src/cli/commands/query.ts`, and graph access in `src/store/sqlite/adapter.ts`.

Design goal: graph expansion is a candidate-generation/ranking signal, not a replacement retrieval mode. A practical first implementation can:

- run the current BM25/vector candidate path;
- select a bounded seed set from top candidates;
- expand one hop through graph edges using confidence-aware weights;
- dedupe candidates;
- send the combined set through existing scoring/rerank behavior where feasible;
- expose explain metadata for graph candidates and fallback reasons.

Web UI work is required if query controls, result badges, or explain details become visible in Search/Ask surfaces.

Testing focus:

- Query where a linked neighbor improves recall.
- Query where graph expansion is unavailable and output matches current behavior.
- Candidate cap enforcement.
- Explicit-link neighbor outranking inferred/similar neighbor when all else is equal.
- Explain metadata and MCP/CLI output stability.
- Retrieval eval update or documented reason why deterministic unit coverage is sufficient for the slice.

## Acceptance

- `gno_query` can use bounded graph expansion as an optional/default-safe retrieval adjunct, depending on the design decision made during implementation.
- Candidate expansion is bounded and avoids graph-wide explosion.
- Explicit link neighbors receive stronger treatment than inferred/similarity neighbors.
- Explain/debug output identifies graph expansion activity, candidate counts, and fallback reasons.
- Tests cover improved recall scenarios, no-graph fallback, no-embedding fallback, bounded expansion limits, and rerank/scoring interactions.
- Retrieval evals are updated or added where appropriate to measure graph expansion impact.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include targeted retrieval tests/evals, `bun run lint:check`, `bun test`, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

_To be completed when the task is implemented._

## Evidence

_To be completed when the task is implemented._
