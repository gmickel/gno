---
layout: home
title: Home
---

![GNO CLI](/assets/screenshots/cli.jpg)

## Why GNO?

Most search tools are either fast but dumb (grep, find) or smart but slow and cloud-dependent. GNO bridges this gap by running a full hybrid search pipeline (keyword, vector, and re-ranking) entirely on your local machine.

## For AI Agents

Give your local LLM agents a long-term memory. GNO integrates as a Claude Code skill or MCP server, allowing agents to search, read, and cite your local files.

### Claude Code

Install GNO as a skill and search your knowledge base directly from Claude Code:

```bash
gno skill install --scope user
```

![GNO Claude Code Skill](/assets/screenshots/claudecodeskill.jpg)

[Skill setup guide →](/docs/integrations/skills/)

### MCP Clients

Connect GNO to Claude Desktop, Cursor, Raycast, and more:

```bash
gno mcp install                    # Claude Desktop (default)
gno mcp install --target cursor    # Cursor
gno mcp install --target zed       # Zed
gno mcp install --target windsurf  # Windsurf
# ... and 6 more targets
```

![GNO MCP](/assets/screenshots/mcp.jpg)

Once connected, ask things like:

> "Search my local notes for the project roadmap and summarize the Q4 goals."

[MCP setup guide →](/docs/MCP/)

## For Humans

Stop grepping through thousands of Markdown files. Ask GNO questions in plain English and get cited answers from your own notes, documentation, and code.

The Web UI provides a visual dashboard for search, browsing, editing, and AI-powered answers.

![GNO Web UI](/assets/screenshots/webui-home.jpg)

![GNO Search](/assets/screenshots/webui-search.jpg)

![GNO Document Editor](/assets/screenshots/webui-editor.jpg)

![GNO AI Answers](/assets/screenshots/webui-ask-answer.jpg)
