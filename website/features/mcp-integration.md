---
layout: feature
title: MCP Integration
headline: Tool Access for Desktop and Editor Clients
description: Connect GNO to Claude Desktop, Cursor, Zed, Windsurf, Amp, Raycast, and more via MCP. Search, retrieval, graph exploration, document access, and indexing tools over one local server.
keywords: mcp server, claude desktop mcp, cursor mcp, zed mcp, windsurf mcp, model context protocol, local knowledge mcp, ai assistant memory
icon: mcp-integration
slug: mcp-integration
permalink: /features/mcp-integration/
og_image: /assets/images/og/og-mcp-integration.png
benefits:
  - 17 read-only tools by default; 28 total with writes enabled
  - Works with Claude Desktop, Cursor, Zed, Windsurf, Amp
  - Also supports Raycast, LM Studio, LibreChat
  - One-command install for 10 automatic targets
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

**Note**: Copy the exact absolute values from `gno mcp install --dry-run --json`.
The package entrypoint, index, config, data directory, and cache are all part of
the installed workspace identity.

### Config Locations

| Client                 | Path                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Code (user)     | `~/.claude.json`                                                  |
| Claude Code (project)  | `./.mcp.json`                                                     |
| Codex (user)           | `~/.codex/config.toml`                                            |
| Codex (project)        | `./.codex/config.toml`                                            |

### Cursor

Prefer the installer-generated entry:

```bash
gno mcp install --target cursor
```

## Available Tools (17 Default, 28 With Writes)

Once connected, your AI assistant gets the 15 read/diagnostic tools plus two
job-inspection tools below. Starting MCP with `--enable-write` adds 11 mutation
tools.

**Read Tools:**

| Tool                  | Description                    |
| --------------------- | ------------------------------ |
| `gno_search`          | BM25 keyword search            |
| `gno_vsearch`         | Vector similarity search       |
| `gno_query`           | Hybrid search with reranking   |
| `gno_query_diagnose`  | Diagnose target retrieval      |
| `gno_get`             | Retrieve document content      |
| `gno_multi_get`       | Batch document retrieval       |
| `gno_status`          | Check index status             |
| `gno_list_tags`       | List all tags                  |
| `gno_links`           | Get outgoing links             |
| `gno_backlinks`       | Get incoming backlinks         |
| `gno_similar`         | Find semantically similar docs |
| `gno_graph`           | Knowledge graph data           |
| `gno_graph_query`     | Typed graph traversal          |
| `gno_graph_neighbors` | Nearby graph relationships     |
| `gno_graph_path`      | Shortest path between docs     |

**Write Tools (opt-in with `--enable-write`):**

| Tool                              | Description              |
| --------------------------------- | ------------------------ |
| `gno_capture`                     | Create new documents     |
| `gno_add_collection`              | Add document sources     |
| `gno_remove_collection`           | Remove document sources  |
| `gno_sync`                        | Update collections       |
| `gno_embed`                       | Generate embeddings      |
| `gno_index`                       | Full re-index            |
| `gno_clear_collection_embeddings` | Clear collection vectors |
| `gno_create_folder`               | Create workspace folders |
| `gno_rename_note`                 | Rename notes             |
| `gno_move_note`                   | Move notes               |
| `gno_duplicate_note`              | Duplicate notes          |

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
