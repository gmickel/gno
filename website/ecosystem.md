---
layout: page
title: Ecosystem
headline: Tools That Pair with GNO
description: Discover Gordon's other open source projects that integrate with GNO for powerful AI-native workflows. CLI tools for structured development, Google Sheets automation, and Outlook control.
keywords: gno integrations, ai tools, developer tools, claude code, ai workflow, sheets cli, outlook automation
permalink: /ecosystem/
---

GNO is designed to be one piece of a larger AI-native toolkit. These companion projects by the same author work seamlessly with GNO to create powerful, local-first workflows.

## The Tools

### Flow

**Plan first, work second**

Claude Code marketplace plugin for structured development workflow. Research agents, gap analysis, and disciplined execution. Most failures come from weak planning. Flow fixes that.

|                    |                    |
| :----------------- | :----------------- |
| **Type**           | Claude Code Plugin |
| **Integrates via** | Skills, Agents     |
| **Status**         | Released           |

**With GNO**: Flow's research agents can search your indexed documents via GNO's MCP server. Find relevant context from your knowledge base while planning features. The `context-scout` and `repo-scout` agents pair perfectly with `gno query` for comprehensive research.

```bash
# Install Flow
/plugin marketplace add https://github.com/gmickel/gmickel-claude-marketplace
/plugin install flow

# GNO provides the memory, Flow provides the process
gno mcp install --target claude
```

[GitHub](https://github.com/gmickel/gmickel-claude-marketplace) | [Documentation](https://mickel.tech/apps/flow)

---

### sheets-cli

**Google Sheets for humans and agents**

Fast, deterministic CLI for Google Sheets. Key-based updates instead of fragile row indices. Batch operations for atomic workflows. JSON everywhere. Installs as a skill for Claude Code and OpenAI Codex.

|                |                  |
| :------------- | :--------------- |
| **Type**       | CLI + AI Skill   |
| **Built with** | Bun + TypeScript |
| **Status**     | Released         |

**With GNO**: Export search results to spreadsheets for tracking and analysis. AI agents can query your knowledge base with GNO, then write structured results to Sheets. Perfect for research workflows, document inventories, or building dashboards from your indexed content.

```bash
# Search and export to Sheets
gno query "Q4 budget projections" --format json | \
  sheets-cli append --sheet "Research Log"

# Or let Claude do it
"Search my notes for meeting decisions and add them to the tracker sheet"
```

[GitHub](https://github.com/gmickel/sheets-cli) | [Documentation](https://mickel.tech/apps/sheets-cli)

---

### outlookctl

**Control Outlook from the command line**

Local CLI bridge for Outlook Classic automation via COM. AI-assisted email and calendar management with Claude Code. No API keys, no OAuth. Just your existing authenticated session.

|                |                        |
| :------------- | :--------------------- |
| **Type**       | Windows CLI + AI Skill |
| **Built with** | Python + pywin32       |
| **Status**     | Released               |

**With GNO**: Search your indexed documents to find relevant context when drafting emails. AI agents can query your knowledge base before composing responses. Find that meeting note, that decision document, that policy before you reply.

```bash
# Find context, draft email
gno query "authentication decision" --answer
outlookctl draft --to "team@company.com" --subject "Auth approach"

# Or let Claude orchestrate both
"Find what we decided about auth and draft an update email to the team"
```

[GitHub](https://github.com/gmickel/outlookctl) | [Documentation](https://gmickel.github.io/outlookctl/)

---

## The Pattern

These tools share a philosophy:

**Local-first**: Everything runs on your machine. No cloud dependency, no data leaving your control.

**JSON I/O**: Structured input and output for automation. AI agents parse results reliably.

**CLI + Skills**: Both human-usable at the terminal and AI-usable as skills. Same tool, two interfaces.

**Composable**: Each tool does one thing well. Combine them for complex workflows.

---

## Example Workflows

### Research to Report

```bash
# 1. Search your knowledge base
gno query "performance optimization techniques" --format json > results.json

# 2. Write to tracking sheet
sheets-cli append --sheet "Research" --data @results.json

# 3. Draft summary email
outlookctl draft --to "lead@team.com" --subject "Performance research"
```

### AI-Orchestrated Knowledge Work

With all tools installed as skills, Claude can:

1. Search your indexed documents with GNO
2. Synthesize findings into structured data
3. Update your tracking spreadsheet
4. Draft follow-up emails

All from a single natural language request.

### Structured Development

```bash
# Flow plans the feature, GNO provides context
/flow:plan Add caching to the API

# Flow researches your codebase AND your notes
# GNO's semantic search finds related decisions, past attempts, context
```

---

## Get Started

```bash
# Install GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# Add as MCP server for AI integration
gno mcp install --target claude

# Install companion tools
bun install -g sheets-cli    # Google Sheets automation
pip install outlookctl       # Outlook automation (Windows)
```

All tools are open source and actively maintained.

---

## More Tools

Building something that integrates with GNO? Open an issue on [GitHub](https://github.com/gmickel/gno).
