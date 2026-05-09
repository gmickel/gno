---
satisfies:
  - R5
---

# Community detection and graph-analysis integration

## Description

Add lightweight community/cluster analysis after graph contracts and confidence metadata are stable. Use it to improve graph reports, agent navigation, and graph UI summaries without making clustering required for baseline retrieval.

Implementation should start with a pragmatic Bun/TypeScript-friendly approach and only add dependencies after a health check if the benefit is clear.

Docs, Web UI updates when affected, and hosted website updates are part of this task, including graph docs and `~/work/gno.sh` website content.

## Implementation Notes

<!-- Updated by plan-sync: fn-79-graph-aware-retrieval-and-agent.1 established `gno_graph` / `gno graph` as the graph-report surface via `GraphResult.report` + `meta` -->

Start from the stabilized `GraphResult.report` / `GraphMeta` and confidence output from tasks 1-3 plus the Web UI graph surface at `src/serve/public/pages/GraphView.tsx`.

Implementation should be pragmatic:

- Prefer a deterministic TypeScript implementation already sufficient for document graphs.
- If adding a dependency for Louvain/Leiden-style clustering, do the repo-required dependency health check first.
- Community data should be optional in graph output and should not block baseline graph rendering or retrieval.

Expected user surfaces:

- `gno_graph` / `gno graph` report community summary.
- `gno_graph` community metadata for MCP consumers.
- Web UI graph community colors/legend/filtering or an explicit decision not to expose UI controls yet, with rationale.

Testing focus:

- Two or more obvious communities.
- Isolates.
- Sparse graph.
- Large graph fallback/truncation.
- Stable IDs/labels across deterministic runs.

## Acceptance

- Graph analysis can identify communities or clusters for document graphs with deterministic behavior in tests.
- Reports/tools/UI can surface community labels or IDs where useful without breaking existing graph consumers.
- Large graphs and sparse graphs degrade gracefully with warnings or simplified output.
- Dependency choices, if any, are justified by a quick health check and documented.
- Tests cover multi-community graphs, isolates, sparse graphs, and large-graph fallback/truncation behavior.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include graph-analysis tests, `bun run lint:check`, `bun test` where feasible, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

_To be completed when the task is implemented._

## Evidence

_To be completed when the task is implemented._
