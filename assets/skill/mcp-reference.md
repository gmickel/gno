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
`gno_get` or batch refs with `gno_multi_get`. Check `gno_status` first when
freshness or embeddings may be stale.

Use graph tools for relationship context: `gno_graph` for corpus report/stats,
`gno_graph_neighbors` for nearby incoming/outgoing graph context, and
`gno_graph_path` for "how are X and Y connected?" questions. Use
`gno_links`, `gno_backlinks`, and `gno_similar` for one-document expansion.
Graph edges include confidence/audit metadata; prefer `explicit` edges when
answers depend on link certainty.

## Uninstall

```bash
gno mcp uninstall
gno mcp uninstall -t claude-code
```
