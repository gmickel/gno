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

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
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

## Check Status

```bash
gno mcp status
```

## Retrieval Order

For normal questions, start with `gno_query`, then read targeted snippets with
`gno_get` or batch refs with `gno_multi_get`. Pass `graph: true` only when
linked context is worth the extra latency. Check `gno_status` first when freshness or
embeddings may be stale.

Use graph tools for relationship context: `gno_graph` for corpus report/stats,
community summaries,
`gno_graph_neighbors` for nearby incoming/outgoing graph context, and
`gno_graph_path` for "how are X and Y connected?" questions. Use
`gno_links`, `gno_backlinks`, and `gno_similar` for one-document expansion.
Graph edges include confidence/audit metadata; prefer `explicit` edges when
answers depend on link certainty.

## Capture

`gno_capture` is available only when MCP starts with `--enable-write` or
`GNO_MCP_ENABLE_WRITE=1`. It writes quick notes with structured `source:`
frontmatter and returns the same provenance receipt shape as CLI, REST, and SDK
capture, plus legacy MCP fields (`docid`, `absPath`, `overwritten`,
`serverInstanceId`).

Use `collisionPolicy: "open_existing"` to return an existing note without
rewriting, `create_with_suffix` to create the next available path, or legacy
`overwrite: true` to replace the target path. MCP capture syncs the file for FTS
but does not auto-embed; run `gno_embed` or `gno_index` afterward when vector
search should include it.

## Uninstall

```bash
gno mcp uninstall
gno mcp uninstall -t claude-code
```
