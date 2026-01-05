# GNO vs Reor

**Verdict**: Reor is a note-taking app with automatic linking; GNO is a search tool with CLI and MCP access.

Both use local LLMs and vector search, but serve different workflows. Reor is for writing and organizing notes with AI assistance. GNO is for searching existing documents from anywhere (terminal, AI assistants, REST API).

## Get Started

```bash
# GNO
bun install -g @gmickel/gno
gno init ~/notes --name notes && gno index

# Reor
# Download desktop app from reorproject.org
# Select your notes folder, models download automatically
```

## Quick Summary

| Aspect              | GNO                    | Reor                   |
| ------------------- | ---------------------- | ---------------------- |
| **Best for**        | Search-first workflows | Note-taking with AI    |
| **Unique strength** | CLI, MCP, multi-format | Auto note linking      |
| **Type**            | CLI + Web UI           | Desktop app (Electron) |

## Feature Comparison

| Feature                  | GNO                            | Reor                       |
| ------------------------ | ------------------------------ | -------------------------- |
| **Primary Focus**        | Search & retrieval             | Note-taking                |
| **Interface**            | CLI + Web UI                   | Desktop app                |
| **File Formats**         | MD, PDF, DOCX, XLSX, PPTX, TXT | Markdown                   |
| **Multiple Collections** | ✓                              | ✗ Single directory         |
| **AI Answers (RAG)**     | ✓                              | ✓                          |
| **Note Linking**         | ✓ Wiki + Markdown links        | ✓ Auto-linking             |
| **Backlinks**            | ✓ CLI + Web UI                 | ✓                          |
| **Similar Notes**        | ✓ Vector similarity            | ✓                          |
| **Graph View**           | ✓ Interactive force graph      | ✗                          |
| **MCP Support**          | ✓                              | ✗                          |
| **REST API**             | ✓                              | ✗                          |
| **Local LLMs**           | ✓ node-llama-cpp               | ✓ Ollama + Transformers.js |
| **Vector Database**      | SQLite + vec                   | LanceDB                    |
| **License**              | MIT                            | AGPL-3.0                   |

## GNO Advantages

**Multi-format search**: Index PDFs, Word docs, Excel, PowerPoint alongside Markdown. Search everything from one place.

```bash
gno init ~/Documents --name docs
gno index
gno query "Q4 budget projections"  # finds in XLSX, PDF, MD
```

**CLI and automation**: Script searches, pipe to other tools, integrate into workflows.

```bash
gno query "authentication" --format json | jq '.results[].path'
```

**Knowledge graph**: Interactive force-directed graph visualization of document connections.

```bash
gno graph                   # CLI output
gno serve                   # Web UI at /graph
```

**Note linking via CLI**: Explore links programmatically.

```bash
gno links doc.md            # Outgoing links
gno backlinks doc.md        # Documents linking to this one
gno similar doc.md          # Semantically similar notes
```

**MCP for AI assistants**: Let Claude, Cursor, or other AI tools search your documents.

```bash
gno mcp install --target claude
# Now Claude can search your indexed documents
```

**REST API**: Build integrations, web apps, or custom interfaces.

```bash
gno serve
# GET http://localhost:3000/api/search?q=your+query
```

**Multiple collections**: Manage separate indexes for different projects or contexts.

```bash
gno init ~/work --name work
gno init ~/personal --name personal
gno query "meeting notes" --collection work
```

## Reor Advantages

**Automatic note linking**: Related notes appear in sidebar while writing. No manual linking required.

**Visual note editor**: Full-featured Markdown editor with Obsidian-like experience.

**Self-contained desktop app**: No CLI needed, everything in one interface. Download and run.

**Built-in chat**: Q&A interface within the app, chat with your notes directly.

**Model management**: Download and switch LLMs through the UI via Ollama integration.

## When to Choose GNO

- You want to search existing documents, not primarily take notes
- You need CLI access or scripting capabilities
- You want AI assistants to search your documents via MCP
- You work with PDFs, Word docs, or other formats beyond Markdown
- You need a REST API for integrations
- You want multiple separate collections
- MIT license fits your use case better

## When to Choose Reor

- You want a note-taking app with AI features built in
- Automatic note linking is important to your workflow
- You prefer a visual desktop app over CLI
- Your notes are all Markdown
- You want a self-contained app with built-in model management
- You primarily take notes rather than search existing documents

## Complementary Use

You can use both together:

```bash
# Index your Reor notes folder with GNO
gno init ~/ReorNotes --name reor
gno index

# Search from terminal while Reor is closed
gno query "project ideas"

# Let AI assistants access your Reor notes
gno mcp install --target claude
```

This gives you Reor's note-taking and auto-linking plus GNO's CLI, MCP, and multi-format search.
