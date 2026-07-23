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

For normal questions, start with `gno_query`, then read targeted snippets with
`gno_get` or batch refs with `gno_multi_get`. Use `gno_context` for one bounded,
exact evidence handoff. Use `gno_ask` only when a local closed-evidence answer
is specifically useful, and pass the literal boolean `verify: true`; it
abstains unless every substantive claim is supported. This is a support
classification against the retained Capsule, not a guarantee that the corpus
is complete or its sources are true. Pass `graph: true` only when linked context
is worth the extra latency. Check `gno_status` first when freshness or
embeddings may be stale. Use `gno_query_diagnose` when a known target document
should have appeared but did not.

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

## Uninstall

```bash
gno mcp uninstall
gno mcp uninstall -t claude-code
```
