---
satisfies:
  - R3
---

# Edge confidence and graph audit metadata

## Description

Add or derive confidence/audit metadata for graph edges so retrieval and agents can distinguish explicit links from inferred fallbacks and similarity relationships.

The model should preserve existing graph behavior while making edge trust visible: explicit wiki/markdown links, path/title fallback resolution, similarity edges, unresolved targets, and ambiguous matches should be auditable.

Docs, Web UI updates when affected, and hosted website updates are part of this task, including schema docs and `~/work/gno.sh` content when user-visible.

## Implementation Notes

<!-- Updated by plan-sync: fn-79-graph-aware-retrieval-and-agent.1 named the shipped graph contract `GraphResult.report`/`meta` with `bridgeCandidates`, `unresolvedLinks`, and `edgeTypes` -->

Build on the shipped `GraphResult.report` / `GraphMeta` contract from task 1 and traversal surfaces from task 2. Prefer extending `GraphLink`, `GraphReport`, and `GraphMeta` over adding a second graph representation unless a schema migration is explicitly justified.

Suggested confidence model:

- Explicit parsed wiki/markdown links: extracted/explicit.
- Resolver fallback matches such as basename/path-style wiki matches: inferred.
- Similarity edges: inferred with score.
- Unresolved or collision-prone targets: ambiguous/audit warning rather than silent certainty.

Expected user surfaces:

- Confidence metadata on graph edges plus report-level rollups in `gno_graph` / `gno graph` output.
- MCP/CLI graph output with confidence metadata where useful.
- Web UI graph edge styling/legend updates when confidence is visible to users.

Testing focus:

- Exact title/rel_path links.
- Path-style fallback links.
- Similarity edge score propagation.
- Ambiguous duplicate-title or collision-style cases.
- Backward compatibility for existing graph JSON consumers.

## Acceptance

- Graph edges expose confidence/audit metadata or an equivalent documented derivation for explicit, inferred, ambiguous, and similarity relationships.
- Existing graph consumers remain compatible or receive a documented schema/version update with migration tests.
- `gno_graph` / `gno graph` output and MCP graph tools surface confidence/audit information where useful.
- Tests cover explicit links, inferred path/title fallback matches, similarity edges with scores, unresolved links, and ambiguous/collision cases.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include store/API/MCP tests, `bun run lint:check`, `bun test` where feasible, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

Added graph edge confidence and audit metadata across the store graph contract, CLI/MCP output, Web UI graph legend/styling, schemas, docs, and agent skill guidance. Edges now distinguish explicit, inferred, ambiguous, and similarity relationships with report-level audit rollups.

## Evidence

- Commits: db0a84aa7437d305d884a088eb2443cb3fc3542b, gno.sh:29022397df79c1de5679b38170d99eadd903f6aa
- Tests: bun run lint:check, bun test, bun run docs:verify, cd website && mise exec -- make build, cd /Users/gordon/repos/autoresearch-gno-skill && uv run eval.py > run.log 2>&1 (score 100.0, 48/48)
- PRs:
