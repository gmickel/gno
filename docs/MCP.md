# MCP Integration

Use GNO as an MCP server for AI assistants like Claude Desktop, Cursor, and others.

> **Full specification**: See [spec/mcp.md](../spec/mcp.md) for complete tool and resource schemas.

## Overview

MCP (Model Context Protocol) allows AI assistants to access external tools and resources. GNO provides:

- **Tools**: gno_search, gno_vsearch, gno_query, gno_get, gno_multi_get, gno_status
- **Resources**: Access documents via `gno://collection/path`

## Design: Retrieval-Only

GNO's MCP tools are **retrieval-only by design**. Unlike the CLI's `gno ask` command (which runs a local LLM to synthesize answers), MCP tools return search results and document content without LLM processing.

**Why?** Claude, Codex, and other AI agents use much more powerful models. Having GNO call a separate (likely smaller) LLM to synthesize answers would be:
- Slower (extra LLM call)
- Lower quality (local models < Claude/GPT-4)
- Redundant (the client LLM can synthesize directly)

**Intended workflow:**
1. Client LLM uses `gno_query` to retrieve relevant documents
2. Client LLM synthesizes the answer from retrieved context
3. Result: Best retrieval (GNO) + best synthesis (Claude/Codex)

## Quick Install

Use the CLI to install GNO as an MCP server:

```bash
gno mcp install                           # Claude Desktop (default)
gno mcp install --target cursor           # Cursor
gno mcp install --target zed              # Zed
gno mcp install --target windsurf         # Windsurf
gno mcp install --target opencode         # OpenCode
gno mcp install --target amp              # Amp
gno mcp install --target lmstudio         # LM Studio
gno mcp install --target librechat        # LibreChat
gno mcp install --target claude-code      # Claude Code CLI
gno mcp install --target codex            # OpenAI Codex CLI
```

### Scope Options

Some clients support project-level configuration:

```bash
gno mcp install --target cursor --scope project     # .cursor/mcp.json
gno mcp install --target opencode --scope project   # opencode.json
gno mcp install --target librechat --scope project  # librechat.yaml
```

### Other Commands

```bash
gno mcp status                  # Show installation status for all targets
gno mcp uninstall --target X    # Remove GNO from a target
```

## Supported Clients

| Client | Install Command | Scope |
|--------|-----------------|-------|
| Claude Desktop | `gno mcp install` | User |
| Claude Code | `gno mcp install --target claude-code` | User, Project |
| Cursor | `gno mcp install --target cursor` | User, Project |
| Zed | `gno mcp install --target zed` | User |
| Windsurf | `gno mcp install --target windsurf` | User |
| OpenCode | `gno mcp install --target opencode` | User, Project |
| Amp | `gno mcp install --target amp` | User |
| LM Studio | `gno mcp install --target lmstudio` | User |
| LibreChat | `gno mcp install --target librechat` | Project |
| Codex | `gno mcp install --target codex` | User, Project |

**Note**: Warp terminal requires manual UI configuration. See [Warp MCP docs](https://docs.warp.dev/knowledge-and-collaboration/mcp).

## Manual Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Cursor

Add to `~/.cursor/mcp.json`:

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

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

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

### OpenCode

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "gno": {
      "type": "local",
      "command": ["gno", "mcp"],
      "enabled": true
    }
  }
}
```

### Amp

Add to `~/.config/amp/settings.json`:

```json
{
  "amp.mcpServers": {
    "gno": {
      "command": "gno",
      "args": ["mcp"]
    }
  }
}
```

### LM Studio

Add to `~/.lmstudio/mcp.json`:

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

### LibreChat

Add to `librechat.yaml` in your LibreChat project root:

```yaml
mcpServers:
  gno:
    command: gno
    args:
      - mcp
```

## Other MCP Clients

Any MCP-compatible client can connect:

```bash
# Start MCP server manually (for debugging)
gno mcp
```

The server uses stdio transport (JSON-RPC 2.0 over stdin/stdout).

## Available Tools

### gno_search

BM25 keyword search.

```
Query: "authentication"
Collection: (optional)
Limit: 5 (default)
```

### gno_vsearch

Vector semantic search.

```
Query: "how to handle errors gracefully"
```

### gno_query

Hybrid search (BM25 + vector).

```
Query: "database optimization"
```

### gno_get

Retrieve document by ID.

```
ref: "abc123def456"
```

### gno_multi_get

Retrieve multiple documents.

```
refs: ["abc123", "def456"]
```

### gno_status

Check index health.

Returns collection counts, document totals, and health status.

## Resources

Access documents via GNO URIs:

```
gno://notes/projects/readme.md
gno://work/src/main.ts
```

Resource format:
- `gno://<collection>/<relative-path>`

## Usage Patterns

### Searching Your Notes

Ask the AI assistant:

> "Search my notes for meeting decisions from last week"

The assistant will use `gno_search` or `gno_query` to find relevant documents.

### Getting Document Content

Ask:

> "Get the contents of my project README"

The assistant uses `gno_get` with the docid from search results.

### Research Workflow

1. Search: "Find documents about API authentication"
2. Review results and scores
3. Get full content of relevant docs
4. Ask follow-up questions with context

## Troubleshooting

### "Tool not found"

Ensure GNO is installed globally:

```bash
bun install -g @gmickel/gno
which gno  # Should show path
```

### "No results"

Check that documents are indexed:

```bash
gno ls
gno status
```

### Connection Issues

Verify MCP server works:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | gno mcp
```

Should return a valid JSON-RPC response.

### Debug Mode

Enable verbose logging:

```bash
GNO_VERBOSE=1 gno mcp
```

## Performance Tips

- Index only what you need (use `--pattern` filters)
- Use specific collections for faster searches
- Pre-download models: `gno models pull --all`
