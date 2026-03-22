---
layout: feature
title: MCP Integration
headline: Give Your AI Assistant Memory
description: Connect GNO to Claude Desktop, Cursor, Zed, Windsurf, Amp, Raycast, and more via MCP. 19 tools for search, retrieval, graph exploration, and indexing. Your AI can search and cite your local documents.
keywords: mcp server, claude desktop mcp, cursor mcp, zed mcp, windsurf mcp, amp mcp, model context protocol, ai assistant memory, local knowledge mcp
icon: mcp-integration
slug: mcp-integration
permalink: /features/mcp-integration/
og_image: /assets/images/og/og-mcp-integration.png
benefits:
  - 19 MCP tools for search, retrieval, graph, and indexing
  - Works with Claude Desktop, Cursor, Zed, Windsurf, Amp
  - Also supports Raycast, LM Studio, LibreChat
  - One-command install for 10+ clients
  - Write tools disabled by default (security-first)
  - Resource URIs for direct document access
commands:
  - "gno mcp install"
  - "gno mcp install --target cursor"
  - "gno mcp install --target zed"
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

| Client                 | Path                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code (user)     | `~/.claude.json`                                                  |
| Claude Code (project)  | `./.mcp.json`                                                     |
| Codex (user)           | `~/.codex.json`                                                   |

### Cursor

Configure in Cursor's MCP settings with the command:

```
gno mcp
```

## Available Tools (19 Total)

Once connected, your AI assistant can use:

**Read Tools:**

| Tool            | Description                    |
| --------------- | ------------------------------ |
| `gno_search`    | BM25 keyword search            |
| `gno_vsearch`   | Vector similarity search       |
| `gno_query`     | Hybrid search with reranking   |
| `gno_get`       | Retrieve document content      |
| `gno_multi_get` | Batch document retrieval       |
| `gno_status`    | Check index status             |
| `gno_list_tags` | List all tags                  |
| `gno_links`     | Get outgoing links             |
| `gno_backlinks` | Get incoming backlinks         |
| `gno_similar`   | Find semantically similar docs |
| `gno_graph`     | Knowledge graph data           |

**Write Tools (opt-in with `--enable-write`):**

| Tool                    | Description             |
| ----------------------- | ----------------------- |
| `gno_capture`           | Create new documents    |
| `gno_add_collection`    | Add document sources    |
| `gno_remove_collection` | Remove document sources |
| `gno_sync`              | Update collections      |
| `gno_embed`             | Generate embeddings     |
| `gno_index`             | Full re-index           |

**Job Tools:**

| Tool             | Description           |
| ---------------- | --------------------- |
| `gno_job_status` | Check async job state |
| `gno_list_jobs`  | List all jobs         |

## Example Prompts

Ask your AI assistant:

> "Search my notes for the project roadmap and summarize the Q4 goals."

> "Find all documents about authentication and list the key decisions."

> "What did I write about database migrations last month?"

Your AI will search your local documents and cite sources in its response.
