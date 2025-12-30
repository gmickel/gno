---
layout: feature
title: MCP Integration
headline: Give Your AI Assistant Memory
description: Connect GNO to Claude Desktop, Claude Code, Cursor, or any MCP-compatible AI assistant. Your AI can now search and cite your local documents.
keywords: mcp server, claude desktop integration, claude code integration, cursor integration, ai assistant, model context protocol
icon: mcp-integration
slug: mcp-integration
permalink: /features/mcp-integration/
benefits:
  - Works with Claude Desktop
  - Works with Claude Code
  - Works with Cursor
  - Standard MCP protocol
  - Search, read, and cite documents
commands:
  - "gno mcp install"
  - "gno mcp status"
---

## What is MCP?

Model Context Protocol (MCP) is a standard that lets AI assistants access external tools and data sources. GNO implements an MCP server that gives your AI access to your local documents.

## Quick Setup

### Claude Desktop

```bash
gno mcp install
```

Restart Claude Desktop. GNO tools will appear in the tool list.

### Claude Code

```bash
# User-level (all projects)
gno mcp install --target claude-code

# Project-level (current project only)
gno mcp install --target claude-code --scope project
```

### Check Status

```bash
gno mcp status
```

Shows which clients have GNO configured.

## Advanced Setup

For manual configuration or unsupported clients, add to the client's MCP config:

```json
{
  "mcpServers": {
    "gno": {
      "command": "/path/to/bun",
      "args": ["/path/to/gno", "mcp"]
    }
  }
}
```

**Note**: Use absolute paths. Claude Desktop runs in a sandboxed environment with a limited PATH.

### Config Locations

| Client | Path |
|--------|------|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code (user) | `~/.claude.json` |
| Claude Code (project) | `./.mcp.json` |
| Codex (user) | `~/.codex.json` |

### Cursor

Configure in Cursor's MCP settings with the command:
```
gno mcp
```

## Available Tools

Once connected, your AI assistant can:

| Tool | Description |
|------|-------------|
| `gno_search` | BM25 keyword search |
| `gno_vsearch` | Vector similarity search |
| `gno_query` | Hybrid search |
| `gno_get` | Retrieve document content |
| `gno_multi_get` | Batch document retrieval |
| `gno_status` | Check index status |

## Example Prompts

Ask your AI assistant:

> "Search my notes for the project roadmap and summarize the Q4 goals."

> "Find all documents about authentication and list the key decisions."

> "What did I write about database migrations last month?"

Your AI will search your local documents and cite sources in its response.
