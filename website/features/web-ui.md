---
layout: feature
title: Web UI
headline: Visual Search at Your Fingertips
description: A local web dashboard for searching, browsing, creating, and editing documents. Full-featured markdown editor with live preview, keyboard shortcuts, and AI-powered answers—all running 100% locally.
keywords: gno web ui, local search dashboard, document browser, visual search, ai answers web interface, markdown editor, note taking
icon: globe
slug: web-ui
permalink: /features/web-ui/
benefits:
  - Split-view markdown editor with live preview
  - Quick capture for instant note creation
  - Create, edit, and delete documents
  - Visual search with BM25, vector, and hybrid modes
  - AI answers with citations
  - Keyboard-first design
  - Live preset switching
  - 100% local, no cloud
commands:
  - "gno serve"
  - "gno serve --port 8080"
---

## Your Knowledge, Visualized

Not everyone wants to live in the terminal. The GNO Web UI gives you a beautiful, fast interface to your local knowledge index. Right in your browser.

```bash
gno serve
# Open http://localhost:3000
```

## Features

### Document Editor

Create and edit documents directly in your browser:

- **Split-view editing**: CodeMirror 6 editor with live markdown preview
- **Auto-save**: Changes saved automatically with 2-second debounce
- **Quick capture**: Press **N** anywhere to create a new note instantly
- **Syntax highlighting**: Code blocks rendered with Shiki
- **Keyboard shortcuts**: **⌘S** to save, **⌘B** for bold, **⌘I** for italic

### Dashboard

See your index at a glance:

- **Document count**: How much you've indexed
- **Chunk count**: Searchable text segments
- **Health status**: Is everything working?
- **Collections**: Jump to any source

### Three Search Modes

Choose the right tool for the job:

| Mode       | Best For                      |
| :--------- | :---------------------------- |
| **BM25**   | Exact terms, code identifiers |
| **Vector** | Concepts, natural language    |
| **Hybrid** | Best accuracy (recommended)   |

### AI Answers

Type a question, get a cited answer:

> "What did we decide about the authentication flow?"

GNO searches your documents, synthesizes an answer using a local LLM, and shows citations linking back to sources.

### Live Preset Switching

Switch between model presets without restarting:

- **Slim**: Default, fast, ~1GB disk
- **Balanced**: Slightly larger, ~2GB disk
- **Quality**: Best answers, ~2.5GB disk

Click the preset selector, choose your preference, and GNO reloads models automatically.

### In-Browser Model Download

Missing models? Download them directly from the UI:

1. Open the preset selector
2. Click **Download Models**
3. Watch the progress bar
4. Start using AI features immediately

No terminal required. Everything happens in the browser.

## Privacy by Design

Everything runs on `localhost`:

- No cloud services
- No user accounts
- No data leaves your machine
- No tracking or telemetry

The server binds to `127.0.0.1` only. It's not accessible from your network.

## Get Started

```bash
# Install GNO
bun install -g @gmickel/gno

# Index your documents
gno init ~/notes --name notes
gno index

# Start the web UI
gno serve
```

Then open [http://localhost:3000](http://localhost:3000).

## For Developers

The Web UI is powered by a REST API you can use programmatically. Build custom integrations, automate workflows, or create your own tools.

```bash
# Search via API
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication"}'
```

See the [API Reference](/docs/API/) for full documentation.
