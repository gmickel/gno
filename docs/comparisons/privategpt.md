# GNO vs PrivateGPT

**Verdict**: Both are privacy-first local RAG solutions. PrivateGPT is a Python-based server with Gradio UI and multiple LLM backend options, GNO is a TypeScript CLI with MCP integration and REST API. Choose PrivateGPT for flexible LLM backends and Python ecosystem, GNO for developer workflows and AI agent integration.

Both tools enable private document Q&A using local LLMs. Here's how they compare.

## Get Started

```bash
# GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# PrivateGPT (Ollama setup)
git clone https://github.com/zylon-ai/private-gpt
cd private-gpt
poetry install --extras "ui llms-ollama embeddings-ollama vector-stores-qdrant"
ollama pull llama3.1 && ollama pull nomic-embed-text
PGPT_PROFILES=ollama make run
```

## Quick Summary

| Aspect              | GNO                   | PrivateGPT                     |
| ------------------- | --------------------- | ------------------------------ |
| **Best for**        | Developers, AI agents | Python devs, flexible backends |
| **Unique strength** | CLI, MCP, REST API    | Multiple LLM providers         |
| **Stack**           | Bun/TypeScript        | Python/FastAPI/Gradio          |
| **License**         | MIT                   | Apache-2.0                     |

## Feature Comparison

| Feature              | GNO                            | PrivateGPT                                                              |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| **File Formats**     | MD, PDF, DOCX, XLSX, PPTX, TXT | MD, PDF, DOCX, PPTX, EPUB, CSV, JSON, MBOX, IPYNB, images, audio, video |
| **Search Modes**     | BM25, Vector, Hybrid           | Vector (Qdrant)                                                         |
| **Reranking**        | ✓ Cross-encoder                | ✗                                                                       |
| **AI Answers (RAG)** | ✓                              | ✓                                                                       |
| **Web UI**           | ✓ `gno serve`                  | ✓ Gradio                                                                |
| **REST API**         | ✓                              | ✓ FastAPI (OpenAI-compatible)                                           |
| **CLI**              | ✓ Full-featured                | ✗ Scripts only                                                          |
| **MCP Support**      | ✓ 10+ targets                  | ✗                                                                       |
| **Local LLMs**       | ✓ node-llama-cpp               | ✓ llama.cpp, Ollama                                                     |
| **Database**         | SQLite (embedded)              | Qdrant (requires service)                                               |
| **Setup Complexity** | Single command                 | Git clone, Poetry, backend setup                                        |
| **Query Expansion**  | ✓ LLM-powered                  | ✗                                                                       |
| **HyDE**             | ✓                              | ✗                                                                       |
| **Model Presets**    | ✓ slim/balanced/quality        | ✗                                                                       |
| **Folder Watch**     | ✗                              | ✓                                                                       |

## LLM Backend Support

| Provider            | GNO        | PrivateGPT |
| ------------------- | ---------- | ---------- |
| **Local llama.cpp** | ✓ Built-in | ✓          |
| **Ollama**          | ✗          | ✓          |
| **OpenAI**          | ✗          | ✓          |
| **Azure OpenAI**    | ✗          | ✓          |
| **Google Gemini**   | ✗          | ✓          |
| **AWS SageMaker**   | ✗          | ✓          |
| **vLLM**            | ✗          | ✓          |

## GNO Advantages

**CLI-first design**: Full-featured command line for scripting and automation.

```bash
gno query "authentication flow" --format json | jq '.results[0]'
```

**MCP integration**: One-command setup for Claude, Cursor, Windsurf, and more.

```bash
gno mcp install --target cursor
```

**Hybrid search with reranking**: BM25 + vector search with cross-encoder reranking for better results.

```bash
gno ask "how does caching work" --depth thorough --answer
```

**Zero-dependency database**: SQLite embedded, no external services needed.

**Single command install**: npm/bun global install, ready in seconds.

**Skills**: Native integration for Claude Code, Codex, OpenCode, OpenClaw.

## PrivateGPT Advantages

**Multiple LLM backends**: Switch between Ollama, llama.cpp, OpenAI, Azure, Gemini, SageMaker, and vLLM via config profiles.

**Broader file format support**: Handles EPUB, MBOX, Jupyter notebooks, images, audio, and video files.

**OpenAI-compatible API**: Drop-in replacement for OpenAI API clients.

**Folder watching**: Automatic ingestion when files change.

```bash
python scripts/ingest_folder.py /docs --watch
```

**Python ecosystem**: Built with FastAPI and LlamaIndex, easy to extend for Python developers.

**Production deployment options**: Docker images and multiple deployment configurations included.

## When to Choose GNO

- You want CLI access for scripting and automation
- You need MCP integration for AI coding assistants (Claude, Cursor, Windsurf)
- You prefer zero-config setup with embedded SQLite
- You want hybrid search with BM25 + vector + reranking
- You need fine-grained search control (depth, expansion, HyDE)
- You work in JavaScript/TypeScript ecosystem

## When to Choose PrivateGPT

- You want to switch between multiple LLM providers (local and cloud)
- You have EPUB, audio, video, or Jupyter notebook files
- You want OpenAI-compatible API for existing integrations
- You prefer Python ecosystem and LlamaIndex
- You need folder watching for automatic ingestion
- You want production deployment with Docker

## Architecture Comparison

**GNO**: TypeScript/Bun, SQLite + node-llama-cpp, designed for CLI and MCP integration. Single-user, local-first, zero external dependencies.

**PrivateGPT**: Python/FastAPI/Gradio, Qdrant + LlamaIndex, designed for flexible LLM backends. Requires external services (Qdrant, optionally Ollama).
