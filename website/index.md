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

Connect GNO to your AI tools instantly.

**Claude Desktop Config** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Once connected, you can ask Claude things like:
> "Search my local notes for the project roadmap and summarize the Q4 goals."

## Quick Start

```bash
# Install
bun install -g gno

# Initialize with your notes folder
gno init ~/notes --name notes

# Index documents
gno index --yes

# Search
gno query "authentication best practices"
gno ask "summarize the API discussion" --answer
```

[Read the Full Documentation](/docs/QUICKSTART/)