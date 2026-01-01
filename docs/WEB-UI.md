# Web UI

A local web dashboard for visual search, document browsing, and AI-powered answers.

```bash
gno serve
# Open http://localhost:3000
```

---

## Overview

The GNO Web UI provides a graphical interface to your local knowledge index. Everything runs on your machine—no cloud, no accounts, no data leaving your network.

| Page | Purpose |
|:-----|:--------|
| **Dashboard** | Index stats, collections, quick navigation |
| **Search** | BM25, vector, or hybrid search with mode selector |
| **Browse** | Paginated document list, filter by collection |
| **Ask** | AI-powered Q&A with citations |

---

## Quick Start

### 1. Start the Server

```bash
gno serve                    # Default port 3000
gno serve --port 8080        # Custom port
gno serve --index research   # Use named index
```

### 2. Open Your Browser

Navigate to `http://localhost:3000`. The dashboard shows:

- **Document count** — Total indexed documents
- **Chunk count** — Text segments for search
- **Health status** — Index state
- **Collections** — Click to browse by source

### 3. Search

Click **Search** or press `/`. Choose your mode:

| Mode | Description |
|:-----|:------------|
| BM25 | Exact keyword matching |
| Vector | Semantic similarity |
| Hybrid | Best of both (recommended) |

### 4. Ask Questions

Click **Ask** for AI-powered answers. Type your question—GNO searches your documents and synthesizes an answer with citations.

> **Note**: Requires generation model. Run `gno models pull` if answers aren't working.

---

## Features

### Model Presets

Switch between model presets without restarting:

1. Click the preset selector (top-left of header)
2. Choose: **Slim** (fast), **Balanced** (default), or **Quality** (best answers)
3. GNO reloads models automatically

| Preset | Disk | Best For |
|:-------|:-----|:---------|
| Slim | ~1GB | Quick searches, limited resources |
| Balanced | ~2GB | General use |
| Quality | ~2.5GB | Best answer quality |

### Model Download

If models aren't downloaded, the preset selector shows a warning icon. Download directly from the UI:

1. Click the preset selector
2. Click **Download Models** button
3. Watch progress bar as models download
4. Capabilities auto-enable when complete

The download runs in background—you can continue using BM25 search while models download.

### Search Modes

The Search page offers three retrieval modes:

**BM25** — Traditional keyword search. Best for exact phrases, code identifiers, known terms.

**Vector** — Semantic similarity search. Best for concepts, natural language questions, finding related content.

**Hybrid** — Combines BM25 + vector with RRF fusion and optional reranking. Best accuracy for most queries.

### Document Browser

Browse all indexed documents:

- Filter by collection
- Paginated results (20 per page)
- Click any document to view content
- Shows file path, type, last modified

### AI Answers

The Ask page provides RAG-powered Q&A:

1. Enter your question
2. GNO runs hybrid search
3. Local LLM synthesizes answer from top results
4. Citations link to source documents

---

## Configuration

### Command Line Options

```bash
gno serve [options]
```

| Flag | Description | Default |
|:-----|:------------|:--------|
| `-p, --port <num>` | Port to listen on | 3000 |
| `--index <name>` | Use named index | default |

### Environment Variables

| Variable | Description |
|:---------|:------------|
| `NODE_ENV=production` | Disable HMR, stricter CSP |
| `GNO_VERBOSE=1` | Enable debug logging |

---

## Security

The Web UI is designed for local use only:

| Protection | Description |
|:-----------|:------------|
| **Loopback only** | Binds to `127.0.0.1`, not accessible from network |
| **CSP headers** | Strict Content-Security-Policy on all responses |
| **CORS protection** | Cross-origin requests blocked |
| **No external resources** | No CDN fonts, scripts, or tracking |

> **Warning**: Do not expose `gno serve` to the internet. It has no authentication.

> **Pro tip**: Want remote access to your second brain? Since GNO binds to localhost only, use a tunnel:
> - [Tailscale Serve](https://tailscale.com/kb/1312/serve) — Expose to your Tailnet (private, your devices only)
> - [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — Free tier, add Cloudflare Access for auth
> - [ngrok](https://ngrok.com/) — Quick setup, supports basic auth
> - [localcan](https://localcan.com/) — macOS-native, simple
>
> These handle auth/encryption so you can safely access GNO from anywhere.

---

## Architecture

```
Browser
   │
   ▼
┌─────────────────────────────────────┐
│  Bun.serve() on 127.0.0.1:3000     │
│  ├── React SPA (/, /search, etc.)  │
│  └── REST API (/api/*)             │
├─────────────────────────────────────┤
│  ServerContext                      │
│  ├── SqliteAdapter (FTS5)          │
│  ├── EmbeddingPort (vectors)       │
│  ├── GenerationPort (answers)      │
│  └── RerankPort (reranking)        │
└─────────────────────────────────────┘
```

The frontend is a React SPA served by Bun's fullstack dev server. API routes handle search, document retrieval, and AI answers.

---

## Troubleshooting

### "Port already in use"

Another process is using port 3000:

```bash
gno serve --port 3001
```

Or find and kill the process:

```bash
lsof -i :3000
kill -9 <PID>
```

### "No results" in search

Ensure documents are indexed:

```bash
gno status
gno ls
```

If empty, run indexing:

```bash
gno index
```

### AI answers not working

Check if generation model is available:

```bash
gno models list
```

Download if needed:

```bash
gno models pull
```

### Slow performance

- Use **Slim** preset for faster responses
- Reduce result limit in search
- Check disk space for model cache

---

## API Access

The Web UI is powered by a REST API that you can also use programmatically. See the [API Reference](./API.md) for curl examples and endpoint documentation.

```bash
# Example: Search via API
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication patterns"}'
```
