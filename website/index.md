---
layout: home
title: Home
description: "Search every file you own. GNO indexes Obsidian vaults, project docs, PDFs, and Office files with hybrid BM25 + vector search. 100% local, works with Claude Code, Codex, Cursor, and 10+ AI agents."
keywords: local search, semantic search, obsidian search, knowledge engine, hybrid search, MCP server, Claude Code, privacy-first, AI agent memory, local RAG
---

![GNO CLI](/assets/screenshots/cli.jpg)

## Why GNO?

Your files are scattered across Obsidian vaults, project directories, research folders, and code repos. Existing search is either fast but dumb (grep, Spotlight) or smart but cloud-dependent. GNO runs a full hybrid search pipeline—BM25 keyword matching, vector similarity, query expansion, cross-encoder reranking—entirely on your machine.

**15,000+ documents. Sub-second search. Zero cloud.**

## The Ideal AI Agent Companion

Your coding agent is only as good as the context it can access. GNO gives Claude Code, Codex, OpenCode, OpenClaw, Cursor, and any MCP-compatible client instant access to your entire knowledge base.

### Skills (Zero Overhead)

Install GNO as a skill—no MCP server, no context window pollution. Your agent calls GNO on demand.

```bash
gno skill install --scope user                # Claude Code (default)
gno skill install --target codex              # OpenAI Codex
gno skill install --target opencode           # OpenCode
gno skill install --target openclaw           # OpenClaw
gno skill install --target all                # All agents at once
```

![GNO Claude Code Skill](/assets/screenshots/claudecodeskill.jpg)

[Skill setup guide →](/docs/integrations/skills/)

### MCP Server (19 Tools)

Connect GNO to Claude Desktop, Cursor, Zed, Windsurf, Amp, Raycast, LM Studio, and more:

```bash
gno mcp install                    # Claude Desktop (default)
gno mcp install --target cursor    # Cursor
gno mcp install --target zed       # Zed
gno mcp install --target windsurf  # Windsurf
gno mcp install --target amp       # Amp
# ... and 6 more targets
```

![GNO MCP](/assets/screenshots/mcp.jpg)

Once connected, ask things like:

> "Search my notes for the authentication decision and summarize the trade-offs."

[MCP setup guide →](/docs/MCP/)

## For Builders

Embed GNO directly inside another Bun or TypeScript app with the SDK—no subprocess overhead, no local server.

```ts
import { createDefaultConfig, createGnoClient } from "@gmickel/gno";

const config = createDefaultConfig();
config.collections = [
  {
    name: "notes",
    path: "/Users/me/notes",
    pattern: "**/*",
    include: [],
    exclude: [],
  },
];

const client = await createGnoClient({ config, dbPath: "/tmp/gno-sdk.sqlite" });
await client.index({ noEmbed: true });
const results = await client.search("JWT token");
await client.close();
```

[SDK guide →](/docs/SDK/)

## For Humans

Stop grepping through thousands of Markdown files. Ask GNO questions in plain English and get cited answers from your own notes, documentation, and code.

The Web UI provides a visual dashboard for search, browsing, safe editing, quick switching, and AI-powered answers. Converted binary sources stay read-only, while markdown/plaintext notes remain editable. Filter by [tags](/features/tags/) extracted from your frontmatter for instant precision.

![GNO Web UI](/assets/screenshots/webui-home.jpg)

![GNO Search](/assets/screenshots/webui-search.jpg)

![GNO Document Editor](/assets/screenshots/webui-editor.jpg)

![GNO Document Viewer](/assets/screenshots/webui-doc-view.jpg)

![GNO AI Answers](/assets/screenshots/webui-ask-answer.jpg)

### Knowledge Graph

See how your ideas connect. The interactive knowledge graph visualizes wiki links, markdown links, and semantic similarity as a navigable constellation. Click any node to jump to that document.

![GNO Knowledge Graph](/assets/screenshots/webui-graph.jpg)

[Knowledge Graph feature →](/features/graph-view/)
