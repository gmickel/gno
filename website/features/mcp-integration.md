---
layout: feature
title: MCP Integration
headline: Give Your AI Assistant Memory
description: Connect GNO to Claude Desktop, Cursor, or any MCP-compatible AI assistant. Your AI can now search and cite your local documents.
keywords: mcp server, claude desktop integration, cursor integration, ai assistant, model context protocol
icon: mcp-integration
slug: mcp-integration
permalink: /features/mcp-integration/
benefits:
  - Works with Claude Desktop
  - Works with Cursor
  - Standard MCP protocol
  - Search, read, and cite documents
commands:
  - "gno mcp"
---

## What is MCP?

Model Context Protocol (MCP) is a standard that lets AI assistants access external tools and data sources. GNO implements an MCP server that gives your AI access to your local documents.

## Setup

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

Restart Claude Desktop. GNO tools will appear in the tool list.

### Cursor

Configure in Cursor's MCP settings with the same command:
```
gno mcp
```

## Available Tools

Once connected, your AI assistant can:

| Tool | Description |
|------|-------------|
| `search` | BM25 keyword search |
| `vsearch` | Vector similarity search |
| `query` | Hybrid search |
| `get` | Retrieve document content |
| `multi_get` | Batch document retrieval |
| `status` | Check index status |

## Example Prompts

Ask your AI assistant:

> "Search my notes for the project roadmap and summarize the Q4 goals."

> "Find all documents about authentication and list the key decisions."

> "What did I write about database migrations last month?"

Your AI will search your local documents and cite sources in its response.
