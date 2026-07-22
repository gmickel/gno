# Cursor Integration

Use GNO to give Cursor access to your local documents and knowledge base via MCP.

## Quick Setup

```bash
# Install GNO
bun install -g @gmickel/gno

# Initialize and index your documents
gno init ~/notes --name notes
gno index

# Install MCP for Cursor (user-level)
gno mcp install --target cursor
```

Restart Cursor. GNO tools are now available in Composer and Chat.

## Project-Level Setup

For project-specific knowledge:

```bash
# Install to .cursor/mcp.json in current project
gno mcp install --target cursor --scope project
```

This creates `.cursor/mcp.json` - commit it to share with your team.

## What You Can Do

Ask Cursor's AI:

- "Search my docs for authentication examples"
- "Find relevant code patterns in my notes"
- "What does my knowledge base say about error handling?"

## Example Prompts

**Coding with context:**

> "Search my notes for how we handle API errors, then apply that pattern here"

**Finding examples:**

> "Find examples of React hooks in my knowledge base"

**Research:**

> "Search my docs for anything about database migrations"

## Manual Configuration

Run `gno mcp install --target cursor --dry-run --json`, then add the reported
absolute values to `~/.cursor/mcp.json` (user) or `.cursor/mcp.json` (project):

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

## Troubleshooting

**Tools not appearing**

1. Check `gno mcp status`
2. Restart Cursor completely
3. Try `gno mcp uninstall --target cursor && gno mcp install --target cursor`

**No results**

```bash
gno ls        # List indexed docs
gno status    # Check index health
```

## Tips

- Use project-level install for team knowledge bases
- Index code docs alongside your project: `gno init ./docs --name project-docs`
- Combine with your notes: `gno init ~/notes --name personal-notes`
