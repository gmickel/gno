---
name: gno
description: Search local documents, files, notes, and knowledge bases. Index directories, search with BM25/vector/hybrid, get AI answers with citations. Use when user wants to search files, find documents, query notes, look up information in local folders, index a directory, set up document search, build a knowledge base, needs RAG/semantic search, or wants to start a local web UI for their docs.
allowed-tools: Bash(gno:*) Read
---

# GNO - Local Knowledge Engine

Fast local semantic search for your documents. Index once, search instantly. No cloud, no API keys.

**Role**: Document search and knowledge retrieval assistant
**Goal**: Help users index, search, query, and get answers from their local documents

## When to Use This Skill

- User asks to **search files, documents, or notes**
- User wants to **find information** in local folders
- User needs to **index a directory** for searching
- User mentions **PDFs, markdown, Word docs, code** they want to search
- User asks about **knowledge base** or **RAG** setup
- User wants **semantic/vector search** over their files
- User needs to **set up MCP** for document access
- User wants a **web UI** to browse/search documents
- User asks to **get AI answers** from their documents
- User wants to **tag, categorize, or label** documents
- User needs to **filter search by tags** or categories

## Quick Start

```bash
# 1. Initialize in any directory
gno init

# 2. Add a collection (folder of docs)
gno collection add ~/docs --name docs

# 3. Index documents
gno index

# 4. Search
gno search "your query"
```

## Core Commands

### Search Commands

| Command               | Description                                 |
| --------------------- | ------------------------------------------- |
| `gno search <query>`  | BM25 keyword search (fast, exact terms)     |
| `gno vsearch <query>` | Vector semantic search (meaning-based)      |
| `gno query <query>`   | Hybrid search (BM25 + vector + rerank)      |
| `gno ask <question>`  | Get AI answer with citations from your docs |

### Search Options

```bash
# Limit results
gno search "api" -n 10

# Filter by collection
gno query "auth" --collection work

# Filter by tags
gno search "api" --tags-any project,work     # Has ANY of these tags
gno query "auth" --tags-all security,prod    # Has ALL of these tags

# Search modes (for query/ask)
gno query "topic" --fast       # ~0.7s, skip expansion/rerank
gno query "topic"              # ~2-3s, default with rerank
gno query "topic" --thorough   # ~5-8s, full pipeline

# Get AI answer
gno ask "how does auth work" --answer

# Output formats
gno search "test" --json       # JSON for parsing
gno search "test" --files      # URIs for piping
```

### Document Retrieval

| Command                   | Description                  |
| ------------------------- | ---------------------------- |
| `gno get <ref>`           | Get document by URI or docid |
| `gno multi-get <refs...>` | Get multiple documents       |
| `gno ls [scope]`          | List indexed documents       |

```bash
gno get gno://work/readme.md
gno get "#a1b2c3d4" --line-numbers
gno ls notes
gno ls --json
```

### Indexing

| Command                                   | Description                         |
| ----------------------------------------- | ----------------------------------- |
| `gno init`                                | Initialize GNO in current directory |
| `gno collection add <path> --name <name>` | Add folder to index                 |
| `gno index`                               | Full index (ingest + embed)         |
| `gno update`                              | Sync files without embedding        |
| `gno embed`                               | Generate embeddings only            |

```bash
gno init
gno collection add ~/notes --name notes --pattern "**/*.md"
gno index
gno index --collection notes  # Single collection
```

### Model Management

| Command            | Description                           |
| ------------------ | ------------------------------------- |
| `gno models list`  | Show available model presets          |
| `gno models use`   | Switch preset (slim/balanced/quality) |
| `gno models pull`  | Download models                       |
| `gno models clear` | Remove cached models                  |
| `gno models path`  | Show model cache directory            |

```bash
gno models use slim       # Default, fast (~1GB)
gno models use balanced   # Larger model (~2GB)
gno models use quality    # Best answers (~2.5GB)
gno models pull --all
```

### Context Hints

| Command                          | Description            |
| -------------------------------- | ---------------------- |
| `gno context add <scope> "text"` | Add context for scope  |
| `gno context list`               | List all contexts      |
| `gno context check`              | Validate configuration |
| `gno context rm <scope>`         | Remove a context       |

```bash
gno context add "/" "Corporate knowledge base"
gno context add "work:" "Work documents and contracts"
```

### Tags

| Command                    | Description               |
| -------------------------- | ------------------------- |
| `gno tags`                 | List all tags with counts |
| `gno tags add <doc> <tag>` | Add tag to document       |
| `gno tags rm <doc> <tag>`  | Remove tag from document  |

```bash
# List tags
gno tags
gno tags --collection work
gno tags --prefix project/      # Hierarchical tags

# Add/remove tags
gno tags add gno://work/readme.md project/api
gno tags rm "#a1b2c3d4" draft

# Filter searches by tags
gno search "api" --tags-any project,work
gno query "auth" --tags-all security,reviewed
```

Tag format: lowercase, alphanumeric, hyphens, dots. Hierarchical with `/` (e.g., `project/web`, `status/draft`).

### Web UI

| Command             | Description              |
| ------------------- | ------------------------ |
| `gno serve`         | Start web UI (port 3000) |
| `gno serve -p 8080` | Custom port              |

Features: Dashboard, search, browse, document editor, AI Q&A with citations.

### MCP Server

| Command             | Description                     |
| ------------------- | ------------------------------- |
| `gno mcp`           | Start MCP server (stdio)        |
| `gno mcp install`   | Install for Claude Desktop, etc |
| `gno mcp uninstall` | Remove MCP configuration        |
| `gno mcp status`    | Show installation status        |

```bash
gno mcp install --target claude-desktop
gno mcp install --target cursor
gno mcp install --target claude-code --scope project
```

### Skill Management

| Command               | Description                 |
| --------------------- | --------------------------- |
| `gno skill install`   | Install skill for AI agents |
| `gno skill uninstall` | Remove skill                |
| `gno skill show`      | Preview skill files         |
| `gno skill paths`     | Show installation paths     |

```bash
gno skill install --target claude --scope project
gno skill install --target codex --scope user
```

### Admin Commands

| Command          | Description                   |
| ---------------- | ----------------------------- |
| `gno status`     | Show index status             |
| `gno doctor`     | Check system health           |
| `gno cleanup`    | Remove orphaned data          |
| `gno reset`      | Delete all data (use caution) |
| `gno completion` | Shell tab completion          |

```bash
gno status --json
gno doctor
gno completion install
```

## Global Flags

```
--index <name>    Use alternate index (default: "default")
--config <path>   Override config file path
--no-color        Disable colored output
--no-pager        Disable automatic paging
--verbose         Enable verbose logging
--yes             Non-interactive mode
--offline         Use cached models only
--json            JSON output (where supported)
```

## Common Patterns

### Search & Get Full Content

```bash
# Find documents, get full content
gno search "api design" --files | head -1 | cut -d, -f3 | xargs gno get

# JSON pipeline
gno query "auth" --json | jq -r '.results[0].uri' | xargs gno get
```

### AI-Powered Q&A

```bash
# Get answer with sources
gno ask "what are the deployment steps" --answer

# Show all retrieved sources
gno ask "summarize the auth discussion" --answer --show-sources
```

### Scripting

```bash
# Check if indexed
gno status --json | jq '.healthy'

# List all URIs
gno ls --files

# Batch get
gno multi-get abc123 def456 ghi789 --max-bytes 10000
```

## Reference

For complete CLI details, see [cli-reference.md](cli-reference.md).
For MCP server setup, see [mcp-reference.md](mcp-reference.md).
For usage examples, see [examples.md](examples.md).
