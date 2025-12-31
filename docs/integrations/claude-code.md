# Claude Code Integration

Use GNO with Claude Code (Anthropic's CLI) via MCP and Skills.

Claude Code has two integration methods:
- **MCP**: Search tools accessible to Claude
- **Skills**: `/gno` slash command for quick searches

## Quick Setup

```bash
# Install GNO
bun install -g @gmickel/gno

# Initialize and index
gno init ~/notes --name notes
gno index

# Install both MCP and Skills
gno mcp install --target claude-code
```

## Using Skills

Once installed, use the `/gno` slash command:

```
/gno search "authentication patterns"
/gno query "how does our API handle errors"
```

Skills provide quick access without leaving your workflow.

## Using MCP Tools

Claude Code can also use MCP tools automatically. Just ask:

> "Search my notes for deployment procedures"
> "Find my documentation about testing strategies"

Claude will use `gno_query`, `gno_search`, etc. to find relevant content.

## Project-Level Setup

For project-specific knowledge:

```bash
gno mcp install --target claude-code --scope project
```

This creates `.claude/settings.json` with MCP configuration.

## Example Workflows

**Research while coding:**
```
/gno query "error handling best practices"
```

**Find related docs:**
> "Search my notes for anything about the feature I'm working on"

**Get context:**
> "Find my architecture docs and summarize the relevant parts for this change"

## Manual Configuration

Add to `~/.claude/settings.json`:

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

For Skills, add to `~/.claude/settings.json`:

```json
{
  "skills": ["@gmickel/gno"]
}
```

## Troubleshooting

**Skill not found**

```bash
# Verify installation
gno mcp status

# Reinstall
gno mcp install --target claude-code
```

**MCP tools not working**

```bash
# Test MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | gno mcp
```

**No results**

```bash
gno ls        # Check indexed docs
gno status    # Check health
```

## Tips

- Use Skills for quick searches, MCP for complex queries
- Index your project docs: `gno init ./docs --name project`
- Combine with personal notes: `gno init ~/notes --name notes`
