# GNO vs Quivr

**Verdict**: Quivr is a framework for building RAG products. GNO is a ready-to-use local knowledge workspace and retrieval engine. Choose Quivr to build a product, GNO to search and work on your own corpus immediately.

Both tools enable semantic search over documents with AI assistance. Quivr is focused on framework flexibility, while GNO prioritizes immediate productivity, local workflows, and agent-ready retrieval.

## Get Started

```bash
# GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# Quivr
pip install quivr-core
# Python 3.10+ required
```

## Quick Summary

| Aspect              | GNO                          | Quivr                              |
| ------------------- | ---------------------------- | ---------------------------------- |
| **Best for**        | Developers, personal use     | Building RAG applications          |
| **Unique strength** | Zero dependencies, CLI-first | Framework flexibility, YC-backed   |
| **Stack**           | Bun/TypeScript, SQLite       | Python, configurable vector stores |

## Feature Comparison

| Feature              | GNO                             | Quivr                              |
| -------------------- | ------------------------------- | ---------------------------------- |
| **Primary Focus**    | Search tool + platform          | RAG framework                      |
| **Database**         | SQLite (embedded)               | PGVector, Faiss (configurable)     |
| **Setup Complexity** | Single command                  | Python environment + config        |
| **CLI**              | ✓ Full-featured                 | ✗ Library-based                    |
| **Web UI**           | ✓ Built-in                      | ✗ Build your own                   |
| **REST API**         | ✓ Built-in                      | ✗ Build your own                   |
| **MCP Support**      | ✓                               | ✗                                  |
| **LLM Providers**    | Local (llama.cpp)               | OpenAI, Anthropic, Mistral, Ollama |
| **Workflow Config**  | Presets (slim/balanced/quality) | YAML-based custom workflows        |
| **Reranking**        | ✓ Cross-encoder                 | ✓ Cohere integration               |
| **Multi-user**       | ✗                               | ✓ Framework supports it            |

## GNO Advantages

**Zero setup**: Single install command, no external databases or Python environments. SQLite embedded means no PostgreSQL, no Docker, no configuration files.

```bash
bun install -g @gmickel/gno
gno init ~/docs && gno index
gno query "how does authentication work"
```

**CLI-first design**: Full-featured command line with tab completion, output formats (JSON, CSV, MD), and one-command MCP install for 10+ editors.

```bash
gno mcp install --target cursor
gno query "API design patterns" --format json
```

**Built-in Web UI and REST API**: No code required for visual search or API integrations.

```bash
gno serve  # http://localhost:3000
```

**Local-first privacy**: All processing happens on your machine. No API keys required for basic functionality.

## Quivr Advantages

**Framework flexibility**: Build custom RAG applications with configurable components. Define workflows in YAML, swap LLM providers, integrate custom parsers.

```python
from quivr_core import Brain

brain = Brain.from_files(name="my-brain", file_paths=["./docs"])
answer = brain.ask("What is the main topic?")
```

**YC-backed**: Y Combinator partner with active development and community support.

**Multi-LLM support**: Native integration with OpenAI, Anthropic, Mistral, Gemma, and Ollama. Switch providers without code changes.

**Megaparse integration**: Advanced document parsing for complex file formats.

**Shareable abstractions**: "Brains" are reusable, configurable units that can be shared across applications.

## When to Choose GNO

- You want document search working in under a minute
- You prefer CLI tools over Python libraries
- You need built-in Web UI and REST API without writing code
- You want MCP integration with Claude Code, Cursor, or other editors
- You prioritize local-only processing for privacy
- You work primarily with personal or team documents

## When to Choose Quivr

- You're building a custom RAG application in Python
- You need multi-user support or shareable "brains"
- You want to integrate multiple LLM providers (OpenAI, Anthropic, etc.)
- You need YAML-configurable workflows for complex RAG pipelines
- You're comfortable with Python development and package management
- You're building a product, not just searching documents

## Technical Comparison

| Aspect           | GNO                | Quivr                      |
| ---------------- | ------------------ | -------------------------- |
| **Language**     | TypeScript/Bun     | Python                     |
| **License**      | MIT                | Apache 2.0                 |
| **Vector Store** | SQLite (built-in)  | PGVector, Faiss (external) |
| **Embedding**    | Local (llama.cpp)  | Configurable               |
| **Config**       | CLI flags, presets | YAML workflows             |
| **Distribution** | npm package        | pip package                |
