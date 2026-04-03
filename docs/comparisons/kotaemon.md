# GNO vs Kotaemon

**Verdict**: Kotaemon is UI-first for document Q&A. GNO is a local knowledge workspace with stronger CLI/API/agent surfaces and a broader day-to-day workflow around search, browse, graph, and editing.

Both tools provide semantic search for local documents with AI-powered RAG features. Here's how they compare when the question is "document Q&A app" versus "search + workspace + agent memory."

## Get Started

```bash
# GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# Kotaemon (Docker)
docker run -p 7860:7860 ghcr.io/cinnamon/kotaemon:main-lite

# Kotaemon (pip)
pip install kotaemon
```

## Quick Summary

| Aspect              | GNO                   | Kotaemon                    |
| ------------------- | --------------------- | --------------------------- |
| **Best for**        | Developers, AI agents | Document Q&A with citations |
| **Unique strength** | CLI, MCP, REST API    | Citation UI, multi-modal    |
| **Stack**           | Bun/TypeScript        | Python/Gradio               |
| **License**         | MIT                   | Apache-2.0                  |

## Feature Comparison

| Feature             | GNO                      | Kotaemon                  |
| ------------------- | ------------------------ | ------------------------- |
| **Search Modes**    | BM25, Vector, Hybrid     | Full-text, Vector, Hybrid |
| **Reranking**       | ✓ Cross-encoder          | ✓                         |
| **Citations**       | ✓ Source links           | ✓ In-browser PDF preview  |
| **CLI**             | ✓ Full-featured          | ✗                         |
| **Web UI**          | ✓ `gno serve`            | ✓ Gradio                  |
| **REST API**        | ✓                        | ✗                         |
| **MCP Support**     | ✓                        | ✗                         |
| **Multi-modal**     | ✗                        | ✓ Figures, tables         |
| **Query Expansion** | ✓ LLM-powered            | ✗                         |
| **HyDE**            | ✓                        | ✗                         |
| **Model Presets**   | ✓ slim/balanced/quality  | ✗                         |
| **Search Depth**    | ✓ fast/balanced/thorough | ✗                         |

## File Format Support

| Format       | GNO | Kotaemon         |
| ------------ | --- | ---------------- |
| **Markdown** | ✓   | ✓                |
| **PDF**      | ✓   | ✓ Native         |
| **DOCX**     | ✓   | ✓ (Unstructured) |
| **XLSX**     | ✓   | ✓ Native         |
| **PPTX**     | ✓   | ✗                |
| **HTML**     | ✗   | ✓ Native         |
| **MHTML**    | ✗   | ✓ Native         |

## LLM Support

| Provider              | GNO        | Kotaemon           |
| --------------------- | ---------- | ------------------ |
| **Local (llama.cpp)** | ✓ Built-in | ✓ llama-cpp-python |
| **Ollama**            | ✗          | ✓                  |
| **OpenAI**            | ✗          | ✓                  |
| **Azure OpenAI**      | ✗          | ✓                  |
| **Cohere**            | ✗          | ✓                  |

## GNO Advantages

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

**Search refinement**: Query expansion, HyDE, and configurable search depth.

```bash
gno ask "how does caching work" --depth thorough --answer
```

**Skills**: Native integration for Claude Code, Codex, OpenCode, OpenClaw.

**Incremental indexing**: SHA-256 tracking, only re-indexes changed files.

## Kotaemon Advantages

**Advanced citations**: In-browser PDF viewer with highlighted passages and relevance scores. See exactly where answers come from.

**Multi-modal support**: Extract and query figures and tables from documents. Parse complex document layouts.

**Cloud LLM support**: Works with OpenAI, Azure, Cohere out of the box. No local model download required.

**Gradio extensibility**: Customize UI with Gradio components. Theming via kotaemon-gradio-theme.

**Docker-ready**: Multiple Docker images (lite, full, ollama) for quick deployment.

## When to Choose GNO

- You want CLI access for scripting and automation
- You need REST API for custom integrations
- You're integrating with AI coding assistants (Claude, Cursor, Windsurf)
- You want MCP support for agent workflows
- You prefer local-first, no cloud dependencies
- You need fine-grained search control (depth, expansion, HyDE)

## When to Choose Kotaemon

- You want a visual UI for document Q&A
- You need to see citations highlighted in PDF context
- You have documents with complex figures and tables
- You want to use cloud LLMs (OpenAI, Azure, Cohere)
- You prefer Python ecosystem and Gradio
- You need multi-modal document parsing

## Architecture Comparison

**GNO**: TypeScript/Bun, SQLite + node-llama-cpp, designed for CLI and MCP integration. Single-user, local-first.

**Kotaemon**: Python/Gradio, supports multiple LLM backends, designed for interactive document Q&A. Can run locally or containerized.
