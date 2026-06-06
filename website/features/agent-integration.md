---
layout: feature
title: AI Agent Integration
headline: Agent Memory Without Prompt Bloat
description: Give AI coding agents full GNO access via SKILL.md files with zero MCP overhead. One-line install for Claude Code, Codex, OpenCode, and OpenClaw for grounded local retrieval on demand.
keywords: ai agent memory, claude code skill, codex skill, local retrieval skill, skill.md, local knowledge for agents, coding agent memory
icon: agent
slug: agent-integration
permalink: /features/agent-integration/
og_image: /assets/images/og/og-agent-integration.png
benefits:
  - SKILL.md integration (no MCP overhead)
  - Zero context window pollution
  - One-line install for supported agents
  - On-demand knowledge retrieval
  - Second-brain workflow recipes
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

For write-capable workflows, installed skills include recipe playbooks for capture, meeting ingestion, email context, source summaries, idea capture, and citation/provenance. These recipes use user-supplied or exported inputs; GNO does not ship native Gmail, Calendar, Slack, webhook, cron, or background-agent automation.

## How It Works

1. **Install** creates a `SKILL.md` in your agent's config
2. **Recipe files** install alongside the skill for progressive workflow guidance
3. **Agent reads** the skill description (once, on startup)
4. **On demand** agent invokes `gno query`, `gno search`, `gno get`, or `gno capture`
5. **Results returned** directly—no persistent connection

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

## Second-Brain Recipes

```bash
gno skill show --file recipes/brain-first-lookup.md
gno skill show --file recipes/capture-and-file.md
gno skill show --file recipes/meeting-ingestion.md
gno skill show --file recipes/email-context.md
gno skill show --file recipes/source-summary.md
gno skill show --file recipes/idea-capture.md
gno skill show --file recipes/citation-and-provenance.md
```

Use recipes when an agent should search local context before acting, save durable notes with provenance, or verify claims with citations. Write-flavored recipes end with `gno index`, `gno embed`, `gno search`, `gno query`, or `gno get` verification.

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

# Verify install paths
gno skill paths

# Test
# Ask your agent: "Use gno to search for recent project notes"
```

[Full skill documentation →](/docs/integrations/skills/)
