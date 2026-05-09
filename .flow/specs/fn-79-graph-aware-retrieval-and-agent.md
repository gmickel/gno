# Graph-Aware Retrieval and Agent Navigation

## Conversation Evidence

> user (turn 1): "clone https://github.com/safishamsi/graphify to /tmp -- analyse and understand it in full and see what concepts would be useful for gno"
> user (turn 2): "so this would be helpful for retrieval?"
> user (turn 3): "ok so we would be sure to adapt our skill and mcp stuff so an agent knows to do this"
> user (turn 4): "capture all of this into one new spec with tasks etc, in the order you gave me, updating the docs and website (~/work/gno.sh) should be part of these feature builds, as well as detailed testing etc"

## Goal & Context

<!-- Source-tag breakdown: 65% [user] / 25% [paraphrase] / 10% [inferred] -->

GNO should use its existing document graph as a retrieval signal, not replace BM25/vector/rerank with graph traversal. [paraphrase]

The feature builds should make graph structure useful to agents through retrieval behavior, MCP tools, and skill guidance. [user]

Each feature slice must include docs, hosted website updates, and detailed tests instead of leaving those as cleanup work. [user]

## Architecture & Data Models

<!-- Source-tag breakdown: 45% [paraphrase] / 55% [inferred] -->

Use the existing GNO document graph as the base: wiki links, markdown links, backlinks, and optional similarity edges. [paraphrase]

Add graph analysis outputs: hubs, bridge documents, isolated documents, unresolved links, graph health, and eventually communities. [paraphrase]

Add graph-aware retrieval as an adjunct stage: retrieve candidates first, expand via graph neighbors, then rerank/score the combined set. [paraphrase]

Represent edge confidence so agents can distinguish explicit links from inferred/similarity relationships. [paraphrase]

Keep code-symbol graph work scoped and later: useful, but not the first retrieval win. [paraphrase]

## API Contracts

<!-- Source-tag breakdown: 30% [paraphrase] / 70% [inferred] -->

MCP should expose graph navigation tools for relationship questions: neighbors, path, stats/report. [paraphrase]

`gno_query` should be able to benefit from graph expansion without requiring agents to manually orchestrate every neighbor lookup. [paraphrase]

Skill docs should tell agents when to use graph tools: relationship questions, missed obvious related docs, unfamiliar corpus navigation, and "how are X and Y connected?" workflows. [paraphrase]

CLI/API/MCP/Web UI contracts should remain stable unless a task explicitly updates schemas and docs. [inferred]

## Edge Cases & Constraints

- Graph traversal must not replace default hybrid retrieval. [paraphrase]
- Explicit links should outrank inferred/similarity relationships when used as retrieval context. [paraphrase]
- Graph expansion must be bounded to avoid candidate explosion. [inferred]
- Missing embeddings or missing graph edges should degrade to current behavior. [inferred]
- Docs and hosted website updates are part of each feature task's DoD. [user]
- Tests must cover behavior, MCP contracts, skill guidance, docs verification, and relevant evals. [user]

## Acceptance Criteria

- **R1:** GNO can produce a graph report/stats summary over the current document graph, including hubs, isolated documents, unresolved links, and edge-type breakdown. [paraphrase]
- **R2:** MCP exposes graph navigation tools for neighbors, paths, and graph stats/report, with tool descriptions that tell agents when to use them. [paraphrase]
- **R3:** GNO records or derives graph edge confidence/audit metadata so explicit links, inferred fallbacks, and similarity edges are distinguishable. [paraphrase]
- **R4:** `gno_query` can use bounded graph expansion as a retrieval adjunct, with tests showing fallback to current behavior when graph expansion is unavailable. [paraphrase]
- **R5:** Community/cluster analysis is available for graph report/UI/agent navigation after the lower-level graph contracts are stable. [paraphrase]
- **R6:** Scoped code-symbol graph work is planned behind clear boundaries and does not block document-graph retrieval improvements. [paraphrase]
- **R7:** GNO skill instructions are updated so agents know the retrieval order: status when needed, query first, graph/link expansion for relationship context, then targeted document reads. [paraphrase]
- **R8:** User-facing docs, MCP docs, CLI/API docs, Web UI surfaces when affected, and hosted website content are updated in the same task that changes behavior. [user]
- **R9:** Detailed automated tests cover store/API behavior, MCP schemas/tool output, retrieval ranking/expansion behavior, and docs verification. [user]

## Boundaries

- Do not port Graphify wholesale into GNO. [paraphrase]
- Do not make LLM-extracted semantic graph edges the primary source of retrieval truth. [paraphrase]
- Do not build a full all-language static-analysis graph before document graph retrieval improvements land. [paraphrase]
- Do not ship skill/MCP behavior that requires agents to brute-force raw files before using GNO search/graph tools. [paraphrase]

## Decision Context

Graphify's useful concept is not "add a graph"; GNO already has graph primitives. The useful concept is making graph structure explain itself and feed retrieval: reportable topology, traversal tools, confidence/audit metadata, and bounded retrieval expansion. [paraphrase]

## Handoff Notes

Fresh-agent starting points:

- Existing graph data path: `src/store/sqlite/adapter.ts` `getGraph`, `src/store/types.ts` Graph types, `src/cli/commands/graph.ts`, `src/serve/routes/graph.ts`, `src/serve/public/pages/GraphView.tsx`, `src/mcp/tools/links.ts` `handleGraph`.
- Existing link graph inputs: `src/core/links.ts`, `doc_links` storage, `gno_links`, `gno_backlinks`, `gno_similar`, and `gno_graph` MCP/CLI surfaces.
- Existing retrieval path: `src/pipeline/hybrid.ts`, `src/mcp/tools/query.ts`, `src/cli/commands/query.ts`, search docs/evals under `docs/`, `spec/`, and `evals/`.
- Agent skill source of truth: `assets/skill/SKILL.md` plus `assets/skill/cli-reference.md`, `assets/skill/mcp-reference.md`, and `assets/skill/examples.md`.
- User-facing docs and hosted website touchpoints: `docs/CLI.md`, `docs/MCP.md`, `docs/API.md`, `docs/WEB-UI.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/ARCHITECTURE.md`, `website/features/graph-view.md`, `website/features/hybrid-search.md`, `website/features/agent-integration.md`, `website/_data/features.yml`, and the hosted site repo at `~/work/gno.sh`.

Implementation guidance:

- Ship in the task order below. Earlier tasks define graph contracts; later tasks should not invent parallel graph schemas.
- Keep existing `gno_graph` consumers working unless a task intentionally versions output schemas and updates all docs/tests.
- Treat Web UI work as required whenever graph report, confidence, community, or retrieval explain data is user-visible.
- Treat docs and website updates as part of implementation, not follow-up chores.
- Prefer deterministic tests over LLM-dependent tests. Retrieval eval updates are expected when ranking behavior changes.

## Task Breakdown

1. Graph report and stats over the existing document graph.
2. MCP/CLI graph traversal tools plus skill guidance.
3. Edge confidence and graph audit metadata.
4. Graph-aware retrieval expansion inside `gno_query`.
5. Community detection/report/UI integration.
6. Scoped code-symbol graph foundation as later/future work.

Each task includes docs, Web UI updates when affected, hosted website updates, tests, and relevant eval/docs verification gates.
