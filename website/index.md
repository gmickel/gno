---
layout: home
title: Home
---

## Why GNO?

Most search tools are either fast but dumb (grep, find) or smart but slow and cloud-dependent. GNO bridges this gap by running a full hybrid search pipeline—keyword, vector, and re-ranking—entirely on your local machine.

### For Humans
Stop grepping through thousands of Markdown files. Ask GNO questions in plain English and get cited answers from your own notes, documentation, and code.

### For AI Agents
Give your local LLM agents (like Claude Desktop or Cursor) a long-term memory. GNO's **Model Context Protocol (MCP)** server allows agents to search, read, and cite your local files safely.

## Agent Integration

Connect GNO to your AI tools instantly:

```bash
gno mcp install                    # Claude Desktop (default)
gno mcp install --target cursor    # Cursor
gno mcp install --target zed       # Zed
gno mcp install --target windsurf  # Windsurf
# ... and 6 more targets
```

Once connected, you can ask Claude things like:
> "Search my local notes for the project roadmap and summarize the Q4 goals."

[Full MCP setup guide →](/docs/MCP/)

## Quick Start

```bash
# Install
bun install -g @gmickel/gno

# Initialize with your notes folder
gno init ~/notes --name notes

# Index documents (BM25 + vectors)
gno index

# Search
gno query "authentication best practices"
gno ask "summarize the API discussion" --answer
```

[Read the Full Documentation](/docs/QUICKSTART/)