# GNO vs QMD

A detailed comparison of GNO and [QMD](https://github.com/tobi/qmd) (Tobi Lütke's markdown search tool).

Both tools provide semantic search for local documents with AI-powered features. Here's how they compare.

## Quick Summary

| Aspect | GNO | QMD |
|--------|-----|-----|
| **Best for** | Multi-format knowledge bases | Markdown-only collections |
| **Unique strength** | Web UI, REST API, RAG answers | Shopify founder's tool |
| **Language support** | 30+ languages | English-focused |

## Feature Comparison

| Feature | GNO | QMD |
|---------|-----|-----|
| **File Formats** | MD, PDF, DOCX, XLSX, PPTX, TXT | Markdown only |
| **Search Modes** | BM25, Vector, Hybrid | BM25, Vector, Hybrid |
| **Query Expansion** | ✓ LLM-powered | ✓ LLM-powered |
| **Reranking** | ✓ Cross-encoder | ✓ Cross-encoder |
| **HyDE** | ✓ | ✓ |
| **AI Answers (RAG)** | ✓ `gno ask --answer` | ✗ |
| **Web UI** | ✓ `gno serve` | ✗ |
| **REST API** | ✓ `gno serve` | ✗ |
| **Languages** | 30+ (auto-detect) | English-focused |
| **MCP Install CLI** | ✓ 10+ targets | ✗ Manual config |
| **Skills** | ✓ Claude Code, Codex, OpenCode | ✗ |
| **Model Presets** | slim/balanced/quality | Single config |
| **Incremental Index** | ✓ SHA-256 tracking | ✓ |
| **Collection Contexts** | ✓ Semantic hints | ✓ |
| **Output Formats** | JSON, CSV, MD, XML, files | JSON, CSV, MD, XML |

### Planned Features

| Feature | GNO | QMD |
|---------|-----|-----|
| **Raycast Extension** | 🔜 macOS native GUI | ✗ |
| **Tab Completion** | 🔜 Shell integration | ✗ |

## Key Differentiators

### GNO Advantages

**Multi-format support**: Index PDFs, Word documents, Excel spreadsheets, and PowerPoint presentations alongside Markdown. Your knowledge base isn't limited to one format.

```bash
# Index everything in your Documents folder
gno init ~/Documents --name docs
gno index
```

**Multilingual**: Auto-detects 30+ languages. Search across notes in English, German, Japanese, and more without configuration.

**Web UI & REST API**: Visual dashboard for search, browsing, and AI answers. Full REST API for custom integrations.

```bash
gno serve  # Open http://localhost:3000
```

**MCP install CLI**: One-command setup for 10+ targets. QMD requires manual config editing.

```bash
gno mcp install --target cursor
```

**Skills**: Native integration for Claude Code, Codex, and OpenCode via CLI.

**RAG answers with citations**: Get AI-generated answers with source citations.

```bash
gno ask "what is our authentication strategy" --answer
```

**HyDE query expansion**: Generates hypothetical answers to improve semantic search quality.

### QMD Advantages

- Created by Tobi Lütke (Shopify founder)
- Focused simplicity for markdown-only workflows
- Mature, stable codebase

## When to Choose GNO

- You want a Web UI for visual search and browsing
- You need a REST API for custom integrations
- You have PDFs, Word docs, or Office files to search
- You need multilingual support
- You want RAG-style answers from your documents
- You want one-command MCP install for any editor
- You want Claude Code or Codex Skills integration

## When to Choose QMD

- Your knowledge base is 100% Markdown
- You don't need Web UI or REST API
- You prefer a more focused, single-purpose tool

## Migration from QMD

If you're currently using QMD and want to try GNO:

```bash
# Install GNO
bun install -g @gmickel/gno

# Initialize with your existing notes folder
gno init ~/your-notes --name notes

# Index (supports same markdown files QMD uses)
gno index

# Search
gno query "your search query"
```

GNO will index the same Markdown files QMD uses, plus any other document formats in the folder.
