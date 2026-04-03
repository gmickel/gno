---
layout: feature
title: AI Agent Integration
headline: Agent Memory Without Prompt Bloat
description: Give AI coding agents full GNO access via SKILL.md files with zero MCP overhead. One-line install for Claude Code, Codex, OpenCode, OpenClaw, and Amp for grounded local retrieval on demand.
keywords: ai agent memory, claude code skill, codex skill, local retrieval skill, skill.md, local knowledge for agents, coding agent memory
icon: agent
slug: agent-integration
permalink: /features/agent-integration/
og_image: /assets/images/og/og-agent-integration.png
benefits:
  - SKILL.md integration (no MCP overhead)
  - Zero context window pollution
  - One-line install for 4+ agents
  - On-demand knowledge retrieval
  - Works alongside MCP if needed
commands:
  - "gno skill install --scope user"
  - "gno skill install --target codex"
  - "gno skill install --target all"
---

## The Problem with MCP

MCP servers are powerful but add complexity:

- **Always-on process**: Server must be running
- **Context pollution**: Tool descriptions consume tokens every message
- **Configuration friction**: JSON config files per client

## Skills: A Better Way

SKILL.md files let agents invoke GNO **on demand**—no server, no config, no wasted context.

```bash
gno skill install --scope user       # Claude Code
gno skill install --target codex     # OpenAI Codex
gno skill install --target all       # All supported agents
```

Your agent now has access to `/gno` commands that search your knowledge base only when needed.

## How It Works

1. **Install** creates a `SKILL.md` in your agent's config
2. **Agent reads** the skill description (once, on startup)
3. **On demand** agent invokes `gno query` or `gno search`
4. **Results returned** directly—no persistent connection

```
┌─────────────┐    invoke     ┌─────────┐    search    ┌─────────┐
│   Agent     │──────────────▶│   GNO   │─────────────▶│  Index  │
│ (Claude/    │               │   CLI   │              │ (SQLite)│
│  Codex)     │◀──────────────│         │◀─────────────│         │
└─────────────┘    results    └─────────┘    results   └─────────┘
```

## Supported Agents

| Agent        | Command             | Status |
| ------------ | ------------------- | ------ |
| Claude Code  | `--scope user`      | ✓      |
| OpenAI Codex | `--target codex`    | ✓      |
| OpenCode     | `--target opencode` | ✓      |
| OpenClaw     | `--target openclaw` | ✓      |
| Amp          | `--target amp`      | ✓      |

## Example Usage

After installing, ask your agent:

> "Search my notes for the authentication discussion and summarize the key decisions."

The agent will:

1. Invoke `gno query "authentication discussion"`
2. Receive relevant document chunks
3. Synthesize an answer with citations

## Skills vs MCP

| Aspect       | Skills             | MCP                     |
| ------------ | ------------------ | ----------------------- |
| Setup        | One command        | JSON config             |
| Context cost | Zero (on-demand)   | Tools always in context |
| Process      | None               | Server required         |
| Latency      | CLI startup        | Already running         |
| Best for     | Occasional lookups | Heavy integration       |

**Use Skills** for occasional knowledge retrieval with minimal overhead.
**Use MCP** when you need always-available tools or real-time integration.

## Getting Started

```bash
# Install for Claude Code
gno skill install --scope user

# Verify
gno skill status

# Test
# Ask your agent: "Use gno to search for recent project notes"
```

[Full skill documentation →](/docs/integrations/skills/)
