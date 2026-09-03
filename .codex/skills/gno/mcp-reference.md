# GNO MCP Installation

GNO provides an MCP (Model Context Protocol) server for AI client integration.

> **Full reference**: See [gno.sh/docs/MCP](https://www.gno.sh/docs/MCP) for complete tool documentation.

## Quick Install

```bash
# Claude Desktop (default)
gno mcp install

# Claude Code
gno mcp install -t claude-code

# With write tools enabled
gno mcp install --enable-write
```

## Manual Setup

### Claude Desktop

Run `gno mcp install --dry-run --json`, then add the reported absolute values to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gno": {
      "command": "/absolute/path/to/bun",
      "args": [
        "run",
        "/absolute/path/to/@gmickel/gno/src/index.ts",
        "--index",
        "default",
        "--config",
        "/absolute/path/to/index.yml",
        "mcp"
      ],
      "env": {
        "GNO_DATA_DIR": "/absolute/path/to/data",
        "GNO_CACHE_DIR": "/absolute/path/to/cache"
      }
    }
  }
}
```

Config locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Claude Code

```bash
gno mcp install -t claude-code -s user    # User scope
gno mcp install -t claude-code -s project # Project scope
```

Installed entries deliberately pin the current Bun/package entrypoint, active
index, absolute config, data directory, and model cache. Standard clients use
`env`; OpenCode uses `environment`; Codex uses `~/.codex/config.toml` or project
`.codex/config.toml` with `[mcp_servers.gno]` and `[mcp_servers.gno.env]`.
Do not shorten a generated entry to `gno mcp`.

## Check Status

```bash
gno mcp status
```

## Resident Streamable HTTP

`gno serve` and `gno daemon` expose the same read-only-by-default MCP surface at
`http://127.0.0.1:3000/mcp`. Use this URL for clients that support Streamable
HTTP and benefit from shared warm stores, jobs, watchers, and model leases.
Existing `gno mcp install` stdio entries remain valid.

Only `gno daemon` supports an explicit non-loopback bind. It requires a
restrictive bearer-token file plus exact Host and Origin allowlists.
Authentication does not grant writes; `gateway.enableWrite` or
`--mcp-enable-write` is a separate opt-in. `gno serve` always remains
loopback-only.

Inspect the safe lifecycle without exposing paths or secrets:

```bash
curl http://127.0.0.1:3000/api/resident/status
gno serve --status --json
gno daemon --status --json
```

## Retrieval Order

`gno mcp --tool-profile core` (or `gateway.toolProfile: core` for the resident
gateway) advertises only `gno_query`, `gno_search`, `gno_get`, `gno_multi_get`,
`gno_context`, `gno_changes`, and `gno_recall`, plus `gno_capture` and
`gno_remember` with `--enable-write`; their descriptions state when to call
each and what comes back. Every other tool named below is available under the
default `full` profile.

For normal questions, start with `gno_query`, then read targeted snippets with
`gno_get` or batch refs with `gno_multi_get`. Use `gno_context` for one bounded,
exact evidence handoff. Use `gno_ask` only when a local closed-evidence answer
is specifically useful, and pass the literal boolean `verify: true`; it
abstains unless every substantive claim is supported. This is a support
classification against the retained Capsule, not a guarantee that the corpus
is complete or its sources are true. Bounded graph expansion is on by default;
set `graph: false` or `noGraph: true` only for an explicit BM25/vector-only path.
Check `gno_peek` first for counts, backlog, serve liveness, or recent files.
Use `gno_status` for activation, onboarding, or heavy health (missing vectors,
stale embeddings). Use `gno_query_diagnose` when a known target document
should have appeared but did not.

Use `gno_section` only when durable section identity matters (create/resolve a
`SectionTargetV1`). Prefer ordinary `gno_query` → `gno_get` retrieval first.
Exact/recovered results include citation lines and ready-to-use `gno_get`
guidance (`fromLine = lineStart`; `lineCount = lineEnd - lineStart + 1`). Never
cite or navigate ambiguous/stale/missing results.

Use graph tools for relationship context: `gno_graph` for corpus report/stats,
community summaries,
`gno_graph_query` for bounded typed-edge traversal,
`gno_graph_neighbors` for nearby incoming/outgoing graph context, and
`gno_graph_path` for "how are X and Y connected?" questions. Use
`gno_links`, `gno_backlinks`, and `gno_similar` for one-document expansion.
Graph edges include confidence/audit metadata; prefer `explicit` edges when
answers depend on link certainty.

Read-only MCP graph/query diagnostics include `gno_graph_query` and
`gno_query_diagnose`. In `gno_query_diagnose`, pass `fast: true` for a BM25-only
diagnosis that avoids embedding/rerank model initialization.

Before reusing caller-saved Capsule JSON, pass the complete canonical object to
`gno_context_verify`. It reports evidence, ranking, and fingerprint drift
without rebuilding or persisting the Capsule. The complete `gno_context` result
lives in `structuredContent`; its text projection is deliberately compact and
should not be expanded back into duplicate model context.

Use `gno_changes`, `gno_diff`, and `gno_impact` for retained metadata history
and bounded dependency questions. Use `gno_trace_list` and `gno_trace_show` for
private local diagnostics. Invoke `gno_trace_label` only when the user
explicitly provides a relevant, irrelevant, or missing-expected judgment.
Trace export/replay/delete/purge and saved-Capsule watch lifecycle remain
CLI-only.

## Capture

`gno_capture` is available only when MCP starts with `--enable-write` or
`GNO_MCP_ENABLE_WRITE=1`. It writes quick notes with structured `source:`
frontmatter and returns the same provenance receipt shape as CLI, REST, and SDK
capture, plus legacy MCP fields (`docid`, `absPath`, `overwritten`,
`serverInstanceId`).

`presetId` accepts `blank`, `project-note`, `research-note`, `decision-note`,
`prompt-pattern`, `source-summary`, `idea-original`, `person`,
`company-project`, or `meeting`. The typed second-brain presets use flat
frontmatter (`type`, `category`, `tags`) and a synthesis/timeline page pattern;
provenance still comes from the capture `source` fields, not the preset.

Use `collisionPolicy: "open_existing"` to return an existing note without
rewriting, `create_with_suffix` to create the next available path, or legacy
`overwrite: true` to replace the target path. Capture content must be text, and
non-overwrite captures fail instead of replacing a late-arriving file. MCP
capture syncs the file for FTS but does not auto-embed; run `gno_embed` or
`gno_index` afterward when vector search should include it.

## Memory

`gno_recall` (read set) and `gno_remember` (write set, needs `--enable-write`)
are the fact-granular memory contract over a collection configured with
`memoryManaged: true`. Both require `collection` and explicit `scopes`
(1-8, any-intersection visibility, no implicit global scope). Identity
(`caller` / `session`) is mapped server-side from the MCP client name and
transport session, never from tool arguments.

- `gno_recall` with `query`, `collection`, `scopes`, optional `maxFacts` /
  `maxTokens` returns current facts (superseded ones excluded), each with a
  `gno://` cite, `contentHash`, and egress lineage, plus a content-free
  `receipt`. Empty scope returns a `hint` naming `gno remember`.
- `gno_remember` with `text`, `collection`, `scopes` and no `decision` returns
  `outcome: "candidates"` and writes nothing. Pass `decision: "add"` for a
  new fact or `decision: "supersede"` with `predecessorUri` +
  `predecessorHash` from a recall. An exact duplicate returns `existing`; a
  lost supersede race returns `MEMORY_SUPERSEDE_CONFLICT` (recall, decide
  again).
- Pass the recall `receipt` back on `gno_remember` so a recalled span cannot
  be re-stored (`MEMORY_FENCED_REPLAY`); a `gno://` entry in `derivedFrom` is
  rejected (`MEMORY_FENCED_DERIVED`). Optional `source` stores evidence.
- Writes sync for FTS before returning and do not auto-embed.

## Uninstall

```bash
gno mcp uninstall
gno mcp uninstall -t claude-code
```
