# MCP and CLI graph traversal tools plus skill guidance

## Description

Expose graph navigation to agents and users through explicit tools/commands, then update GNO skill instructions so agents know when to use graph traversal instead of raw-file brute force.

Core capabilities should cover neighbors, shortest/path-style relationship lookup, and graph stats/report access. Tool descriptions must encode agent guidance for relationship questions, missed obvious related docs, unfamiliar corpus navigation, and "how are X and Y connected?" prompts.

Docs, Web UI updates when affected, and hosted website updates are part of this task, including MCP docs, skill docs, CLI/API docs where relevant, and `~/work/gno.sh` website content.

## Implementation Notes

Start from `src/mcp/tools/links.ts`, `src/mcp/tools/index.ts`, `src/cli/commands/graph.ts`, `src/store/sqlite/adapter.ts` `getGraph`, and the agent skill source files in `assets/skill/`.

Expected tools/commands:

- Neighbor lookup for a document/reference, optionally filtered by edge type/confidence once task 3 lands.
- Relationship/path lookup between two document refs or graph concepts using current document graph nodes.
- Graph stats/report access for agents.

Agent guidance must land in both MCP tool descriptions and skill docs. The intended agent behavior is: use `gno_query` for normal retrieval, use graph tools for relationship/path/corpus-navigation questions, use `gno_links`/`gno_backlinks`/`gno_similar` for local expansion, then use `gno_get` for targeted reads.

Testing focus:

- MCP schema registration and validation.
- Tool output for found/not-found/empty graph cases.
- CLI/API parity if CLI/API commands are added.
- Skill install/show snapshots or direct skill-content tests as appropriate.

## Acceptance

- MCP exposes graph navigation tools for neighbors, relationship/path lookup, and graph stats/report access.
- CLI or API surfaces exist where appropriate and remain consistent with existing graph output contracts.
- MCP tool descriptions explain when agents should use graph tools versus `gno_query`, `gno_links`, `gno_backlinks`, `gno_similar`, and `gno_get`.
- GNO skill instructions define the retrieval order: status when freshness is uncertain, query first, graph/link expansion for relationship context, then targeted document reads.
- Tests cover MCP schemas, formatted tool output, validation errors, and empty/missing graph cases.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include targeted MCP/CLI tests, `bun run lint:check`, `bun test` where feasible, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

_To be completed when the task is implemented._

## Evidence

_To be completed when the task is implemented._
