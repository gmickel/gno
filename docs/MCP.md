# MCP Integration

Use GNO as an MCP server for AI assistants like Claude Desktop, Cursor, and others.

> **Full specification**: See [spec/mcp.md](../spec/mcp.md) for complete tool and resource schemas.

## Overview

MCP (Model Context Protocol) allows AI assistants to access external tools and resources. GNO provides:

- **Tools**: search, vsearch, query, get, multi_get, status
- **Resources**: Access documents via `gno://collection/path`

## Claude Desktop Setup

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

Restart Claude Desktop. GNO tools will appear in the tool list.

## Cursor Setup

Add to Cursor settings (MCP Servers section):

```json
{
  "gno": {
    "command": "gno",
    "args": ["mcp"]
  }
}
```

## Other MCP Clients

Any MCP-compatible client can connect:

```bash
# Start MCP server manually (for debugging)
gno mcp
```

The server uses stdio transport (JSON-RPC 2.0 over stdin/stdout).

## Available Tools

### gno.search

BM25 keyword search.

```
Query: "authentication"
Collection: (optional)
Limit: 5 (default)
```

### gno.vsearch

Vector semantic search.

```
Query: "how to handle errors gracefully"
```

### gno.query

Hybrid search (BM25 + vector).

```
Query: "database optimization"
```

### gno.get

Retrieve document by ID.

```
Docid: "abc123def456"
```

### gno.multi_get

Retrieve multiple documents.

```
Docids: ["abc123", "def456"]
```

### gno.status

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

The assistant will use `gno.search` or `gno.query` to find relevant documents.

### Getting Document Content

Ask:

> "Get the contents of my project README"

The assistant uses `gno.get` with the docid from search results.

### Research Workflow

1. Search: "Find documents about API authentication"
2. Review results and scores
3. Get full content of relevant docs
4. Ask follow-up questions with context

## Troubleshooting

### "Tool not found"

Ensure GNO is installed globally:

```bash
bun install -g gno
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
