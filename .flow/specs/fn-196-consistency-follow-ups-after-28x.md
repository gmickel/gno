# Consistency follow-ups after 2.8.x: live config, vector maintenance, similar, link edges

## Goal & Context

Loose ends found while shipping 2.8.1 and 2.8.2. Each is small and independent. Together they remove the last places where a surface disagrees with the index or the config after the partitioned vector storage (2.7) and the link-workspace and audit work (2.8).

## Acceptance Criteria

- **R1:** A running `gno serve` or `gno daemon` picks up collections added to or removed from the config file (by the CLI or by hand) without a restart. `/api/status`, MCP `gno_status`, the watcher and search scope all reflect the current config after the change, with the same binding checks and error handling as the sessions config refresh (an unreadable config is an error, never served stale; a config rebound to another index is refused). A regression test covers remove and add while the resident runs.
- **R2:** `gno vec sync`, `gno vec rebuild` and the `doctor` embedding fingerprint check read the active vector partition, not only the legacy `content_vectors` table, and report correct counts on an index embedded by 2.7+. Legacy indexes that never re-embedded keep working. A regression test covers a partitioned index.
- **R3:** `gno similar` computes the source document's vector the same way on every surface (CLI, MCP, REST). Pick one rule (first chunk or mean of chunks), apply it everywhere, and make `spec/cli.md` and `spec/mcp.md` describe it. Scores for the same document match across surfaces.
- **R4:** `gno changes` (and the change journal) stops recording link additions and removals for documents whose source is not Markdown, matching link extraction since 2.8.2. Content changes for those documents are still recorded.
- **R5:** An extensionless Markdown link (`[x](Note)`) whose target note exists on disk inside the link workspace but is not indexed is reported as `links.outside-index`, not unresolved, using the same existence-only rules as wiki links (the file is never opened or indexed).

## Boundaries

- No change to vector storage format, embedding identity, or egress.
- R1 is config reload for collections only; model presets and other settings keep their current restart behaviour.

## Downstream

- gno.sh `scripts/export-index-trace-graph.ts` works around the pre-2.8.1 graph similarity bug by calling `gno similar` per document; switch it back to `gno graph --include-similar` in the gno.sh repo once this ships (separate gno.sh change).
