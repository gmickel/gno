# Claude Desktop Integration

Use GNO to give Claude Desktop access to your local documents via MCP.

## Quick Setup

```bash
# Install GNO
bun install -g @gmickel/gno

# Initialize and index your documents
gno init ~/notes --name notes
gno index

# Install MCP for Claude Desktop
gno mcp install
```

Restart Claude Desktop. GNO tools are now available.

## What You Can Do

Once installed, ask Claude Desktop:

- "Search my notes for meeting decisions"
- "Find documents about authentication"
- "What do my notes say about project X?"
- "Get the contents of my project README"

Claude uses GNO's search tools to find relevant documents, then synthesizes answers.

## Available Tools

| Tool | Purpose |
|------|---------|
| `gno_query` | Hybrid search (best for most queries) |
| `gno_search` | BM25 keyword search |
| `gno_vsearch` | Semantic vector search |
| `gno_get` | Get document by ID |
| `gno_multi_get` | Get multiple documents |
| `gno_status` | Check index health |

## Example Prompts

**Finding information:**
> "Search my notes for anything about API rate limiting"

**Research workflow:**
> "Find my documents about user authentication, then summarize the key points"

**Getting specific content:**
> "Get the full contents of my project's architecture doc"

**Multi-step queries:**
> "Find my meeting notes from last week and list the action items"

## Manual Configuration

If auto-install doesn't work, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Troubleshooting

**"Tool not found"**

```bash
# Verify GNO is installed globally
which gno

# Reinstall if needed
bun install -g @gmickel/gno
```

**"No results"**

```bash
# Check your index
gno ls
gno status
```

**Connection issues**

```bash
# Test MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | gno mcp
```

**Need to reinstall**

```bash
gno mcp uninstall
gno mcp install
# Restart Claude Desktop
```

## Tips

- **Index relevant folders only**: `gno init ~/work --name work --pattern "**/*.md"`
- **Pre-download models**: `gno models pull --all`
- **Check status**: `gno mcp status`
