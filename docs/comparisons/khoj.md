# GNO vs Khoj

**Verdict**: Khoj is a broader personal AI platform. GNO is a tighter local knowledge workspace for developer workflows, stronger retrieval, CLI/API use, and AI agent integration.

The main difference is product shape: Khoj feels like a personal assistant platform, while GNO feels like a local retrieval and workspace engine.

## At a Glance

- Choose **Khoj** if you want a broader assistant-style product with mobile/Notion/cloud-provider flexibility.
- Choose **GNO** if you want stronger retrieval controls, a local workspace, CLI/API surfaces, and tighter integration with coding agents.

## Get Started

```bash
# GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# Khoj (pip)
pip install 'khoj[local]'
USE_EMBEDDED_DB="true" khoj --anonymous-mode

# Khoj (Docker)
mkdir ~/.khoj && cd ~/.khoj
wget https://raw.githubusercontent.com/khoj-ai/khoj/master/docker-compose.yml
docker-compose up
```

## Quick Summary

| Aspect              | GNO                   | Khoj                          |
| ------------------- | --------------------- | ----------------------------- |
| **Best for**        | Developers, AI agents | Personal AI assistant         |
| **Unique strength** | CLI, MCP, REST API    | Multi-platform, custom agents |
| **Stack**           | Bun/TypeScript        | Python/TypeScript             |
| **License**         | MIT                   | AGPL-3.0                      |

## Feature Comparison

| Feature              | GNO                       | Khoj                  |
| -------------------- | ------------------------- | --------------------- |
| **Search Modes**     | BM25, Vector, Hybrid      | Vector (semantic)     |
| **Reranking**        | ✓ Cross-encoder           | ✓ Cross-encoder       |
| **AI Answers (RAG)** | ✓                         | ✓                     |
| **CLI**              | ✓ Full-featured           | ✓ Server command only |
| **Web UI**           | ✓ `gno serve`             | ✓ Gradio-based        |
| **REST API**         | ✓                         | ✓                     |
| **MCP Support**      | ✓ 10+ targets             | ✗                     |
| **Query Expansion**  | ✓ LLM-powered             | ✗                     |
| **HyDE**             | ✓                         | ✗                     |
| **Model Presets**    | ✓ slim/balanced/quality   | ✗                     |
| **Search Depth**     | ✓ fast/balanced/thorough  | ✗                     |
| **Tab Completion**   | ✓ bash/zsh/fish           | ✗                     |
| **Knowledge Graph**  | ✓ Interactive force graph | ✗                     |
| **Note Linking**     | ✓ Wiki + backlinks        | ✗                     |

## File Format Support

| Format       | GNO | Khoj            |
| ------------ | --- | --------------- |
| **Markdown** | ✓   | ✓               |
| **PDF**      | ✓   | ✓               |
| **DOCX**     | ✓   | ✓               |
| **XLSX**     | ✓   | ✗               |
| **PPTX**     | ✓   | ✗               |
| **Org-mode** | ✗   | ✓               |
| **Notion**   | ✗   | ✓ (integration) |
| **Images**   | ✗   | ✓               |

## LLM Support

| Provider              | GNO        | Khoj |
| --------------------- | ---------- | ---- |
| **Local (llama.cpp)** | ✓ Built-in | ✓    |
| **Ollama**            | ✗          | ✓    |
| **OpenAI**            | ✗          | ✓    |
| **Anthropic**         | ✗          | ✓    |
| **Google Gemini**     | ✗          | ✓    |
| **Mistral**           | ✗          | ✓    |

## Database & Infrastructure

| Aspect       | GNO               | Khoj                              |
| ------------ | ----------------- | --------------------------------- |
| **Database** | SQLite (embedded) | PostgreSQL + pgvector             |
| **Setup**    | Single binary     | Multi-container (Docker)          |
| **Services** | 1                 | 4-5 (db, server, sandbox, search) |

## GNO Advantages

GNO is stronger when the question is "how do I search and reuse my own corpus across tools?" rather than "how do I build a personal AI assistant?"

**CLI-first design**: Full-featured command line for scripting and automation.

```bash
gno query "authentication flow" --format json | jq '.results[0]'
```

**MCP integration**: One-command setup for Claude, Cursor, Windsurf, and more.

```bash
gno mcp install --target cursor
```

**REST API**: Programmatic access for custom integrations.

```bash
gno serve  # http://localhost:3000/api
```

**Search refinement**: Query expansion, HyDE, BM25 hybrid, and configurable search depth.

```bash
gno ask "how does caching work" --depth thorough --answer
```

**Zero infrastructure**: SQLite embedded, no separate database server.

**Skills**: Native integration for Claude Code, Codex, OpenCode, OpenClaw.

**MIT License**: Permissive licensing for commercial use.

## Khoj Advantages

Khoj is stronger when the assistant surface itself is the product and you want broad integrations across devices and cloud models.

**Multi-platform access**: Browser, Obsidian, Emacs, Desktop, Phone, WhatsApp integration.

**Custom agents**: Create agents with tunable personality, tools, and knowledge bases.

**Cloud LLM support**: Works with OpenAI, Anthropic, Google, Mistral out of the box.

**Research mode**: Experimental `/research` command for automated research workflows.

**Cloud option**: app.khoj.dev available for zero-setup usage.

**Image generation**: Built-in text-to-image and text-to-speech capabilities.

**Notion integration**: Direct sync with Notion workspaces.

## When to Choose GNO

- You want CLI access for scripting and automation
- You need REST API for custom integrations
- You're integrating with AI coding assistants (Claude, Cursor, Windsurf)
- You want MCP support for agent workflows
- You prefer local-first, no cloud dependencies
- You need fine-grained search control (BM25 hybrid, depth, expansion, HyDE)
- You want simple SQLite setup, no PostgreSQL
- You need MIT licensing for commercial projects

## When to Choose Khoj

- You want multi-platform access (mobile, WhatsApp, Obsidian, Emacs)
- You need to use cloud LLMs (OpenAI, Anthropic, Google)
- You want custom AI agents with different personalities
- You use Notion and want direct integration
- You prefer a managed cloud option (app.khoj.dev)
- You need image/audio generation features
- You work with Org-mode files

## Architecture Comparison

**GNO**: TypeScript/Bun, SQLite + node-llama-cpp, designed for CLI and MCP integration. Single-user, local-first, zero external dependencies.

**Khoj**: Python/TypeScript hybrid, PostgreSQL + pgvector, designed as a personal AI platform. Supports cloud or self-hosted, multi-user capable, requires Docker for full features.
