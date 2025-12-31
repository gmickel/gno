# REST API

HTTP API for programmatic access to GNO search and retrieval.

```bash
gno serve
# API available at http://localhost:3000/api/*
```

---

## Overview

The GNO REST API provides programmatic access to your local knowledge index. Use it to:

- Search documents from scripts and applications
- Build custom integrations
- Automate workflows
- Create dashboards and tools

All endpoints are JSON-based and run entirely on your machine.

---

## Quick Reference

| Endpoint | Method | Description |
|:---------|:-------|:------------|
| `/api/health` | GET | Health check |
| `/api/status` | GET | Index statistics |
| `/api/capabilities` | GET | Available features |
| `/api/collections` | GET | List collections |
| `/api/docs` | GET | List documents |
| `/api/doc` | GET | Get document content |
| `/api/search` | POST | BM25 keyword search |
| `/api/query` | POST | Hybrid search |
| `/api/ask` | POST | AI-powered Q&A |
| `/api/presets` | GET | List model presets |
| `/api/presets` | POST | Switch preset |
| `/api/models/status` | GET | Download status |
| `/api/models/pull` | POST | Start model download |

---

## Authentication

None required. The API binds to `127.0.0.1` only and is not accessible from the network.

> **Security**: Cross-origin requests are blocked. Only same-origin requests from `localhost` are allowed.

---

## Endpoints

### Health Check

```http
GET /api/health
```

**Response**:
```json
{
  "ok": true
}
```

---

### Index Status

```http
GET /api/status
```

Returns index statistics and health.

**Response**:
```json
{
  "indexName": "default",
  "configPath": "/Users/you/.config/gno/index.yml",
  "dbPath": "/Users/you/.local/share/gno/index-default.sqlite",
  "collections": [
    {
      "name": "notes",
      "path": "/Users/you/notes",
      "documentCount": 142,
      "chunkCount": 1853,
      "embeddedCount": 1853
    }
  ],
  "totalDocuments": 142,
  "totalChunks": 1853,
  "embeddingBacklog": 0,
  "lastUpdated": "2025-01-15T10:30:00Z",
  "healthy": true
}
```

**Example**:
```bash
curl http://localhost:3000/api/status | jq
```

---

### Capabilities

```http
GET /api/capabilities
```

Returns available features based on loaded models.

**Response**:
```json
{
  "bm25": true,
  "vector": true,
  "hybrid": true,
  "answer": true
}
```

| Field | Description |
|:------|:------------|
| `bm25` | BM25 search (always true) |
| `vector` | Vector search available |
| `hybrid` | Hybrid search available |
| `answer` | AI answer generation available |

---

### List Collections

```http
GET /api/collections
```

**Response**:
```json
[
  { "name": "notes", "path": "/Users/you/notes" },
  { "name": "work", "path": "/Users/you/work/docs" }
]
```

---

### List Documents

```http
GET /api/docs?collection=notes&limit=20&offset=0
```

**Query Parameters**:

| Param | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `collection` | string | — | Filter by collection name |
| `limit` | number | 20 | Results per page (max 100) |
| `offset` | number | 0 | Pagination offset |

**Response**:
```json
{
  "documents": [
    {
      "docid": "abc123def456",
      "uri": "gno://notes/projects/readme.md",
      "title": "Project README",
      "collection": "notes",
      "relPath": "projects/readme.md",
      "sourceExt": ".md",
      "sourceMime": "text/markdown",
      "updatedAt": "2025-01-15T09:00:00Z"
    }
  ],
  "total": 142,
  "limit": 20,
  "offset": 0
}
```

**Example**:
```bash
curl "http://localhost:3000/api/docs?collection=notes&limit=10" | jq
```

---

### Get Document

```http
GET /api/doc?uri=gno://notes/projects/readme.md
```

**Query Parameters**:

| Param | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `uri` | string | Yes | Document URI |

**Response**:
```json
{
  "docid": "abc123def456",
  "uri": "gno://notes/projects/readme.md",
  "title": "Project README",
  "content": "# Project\n\nThis is the full document content...",
  "contentAvailable": true,
  "collection": "notes",
  "relPath": "projects/readme.md",
  "source": {
    "mime": "text/markdown",
    "ext": ".md",
    "modifiedAt": "2025-01-15T09:00:00Z",
    "sizeBytes": 4523
  }
}
```

**Example**:
```bash
curl "http://localhost:3000/api/doc?uri=gno://notes/readme.md" | jq '.content'
```

---

### BM25 Search

```http
POST /api/search
```

Keyword search using BM25 algorithm.

**Request Body**:
```json
{
  "query": "authentication",
  "limit": 10,
  "minScore": 0.1,
  "collection": "notes"
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `query` | string | — | Search query (required) |
| `limit` | number | 10 | Max results (max 50) |
| `minScore` | number | — | Minimum score threshold (0-1) |
| `collection` | string | — | Filter by collection |

**Response**:
```json
{
  "query": "authentication",
  "mode": "bm25",
  "results": [
    {
      "docid": "abc123",
      "uri": "gno://notes/auth.md",
      "title": "Authentication Guide",
      "collection": "notes",
      "score": 0.87,
      "chunk": {
        "text": "...relevant text snippet...",
        "index": 2
      }
    }
  ],
  "meta": {
    "totalResults": 5
  }
}
```

**Example**:
```bash
curl -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "handleAuth", "limit": 5}'
```

---

### Hybrid Search

```http
POST /api/query
```

Combined BM25 + vector search with optional reranking. **Recommended for best results.**

**Request Body**:
```json
{
  "query": "how to handle authentication errors",
  "limit": 20,
  "minScore": 0.1,
  "collection": "notes",
  "lang": "en",
  "noExpand": false,
  "noRerank": false
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `query` | string | — | Search query (required) |
| `limit` | number | 20 | Max results (max 50) |
| `minScore` | number | — | Minimum score threshold (0-1) |
| `collection` | string | — | Filter by collection |
| `lang` | string | auto | Query language hint |
| `noExpand` | boolean | false | Disable query expansion |
| `noRerank` | boolean | false | Disable cross-encoder reranking |

**Response**:
```json
{
  "query": "how to handle authentication errors",
  "mode": "hybrid",
  "queryLanguage": "en",
  "results": [
    {
      "docid": "abc123",
      "uri": "gno://notes/auth.md",
      "title": "Authentication Guide",
      "collection": "notes",
      "score": 0.92,
      "chunk": {
        "text": "...relevant text snippet...",
        "index": 2
      }
    }
  ],
  "meta": {
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true,
    "totalResults": 12
  }
}
```

**Example**:
```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "error handling best practices", "limit": 10}'
```

---

### AI Answer

```http
POST /api/ask
```

Get an AI-generated answer with citations from your documents.

**Request Body**:
```json
{
  "query": "What is our authentication strategy?",
  "limit": 5,
  "collection": "notes",
  "lang": "en",
  "maxAnswerTokens": 512
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `query` | string | — | Question (required) |
| `limit` | number | 5 | Number of sources to consider (max 20) |
| `collection` | string | — | Filter by collection |
| `lang` | string | auto | Query language hint |
| `maxAnswerTokens` | number | 512 | Max tokens in answer |

**Response**:
```json
{
  "query": "What is our authentication strategy?",
  "mode": "hybrid",
  "queryLanguage": "en",
  "answer": "Based on your documents, the authentication strategy uses JWT tokens with refresh rotation. Key points:\n\n1. Access tokens expire in 15 minutes [1]\n2. Refresh tokens are rotated on each use [2]\n3. Sessions are stored in Redis [1]",
  "citations": [
    { "index": 1, "docid": "abc123", "uri": "gno://notes/auth.md" },
    { "index": 2, "docid": "def456", "uri": "gno://notes/security.md" }
  ],
  "results": [...],
  "meta": {
    "expanded": true,
    "reranked": true,
    "vectorsUsed": true,
    "answerGenerated": true,
    "totalResults": 5
  }
}
```

**Example**:
```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What did we decide about caching?"}'
```

> **Note**: Returns `503` if generation model not loaded. Run `gno models pull` to download.

---

### List Presets

```http
GET /api/presets
```

**Response**:
```json
{
  "presets": [
    {
      "id": "slim",
      "name": "Slim (Fast, ~1GB)",
      "embed": "hf:...bge-m3-Q4...",
      "rerank": "hf:...reranker-Q4...",
      "gen": "hf:...smollm-Q4...",
      "active": false
    },
    {
      "id": "balanced",
      "name": "Balanced (Default, ~2GB)",
      "active": true
    }
  ],
  "activePreset": "balanced"
}
```

---

### Switch Preset

```http
POST /api/presets
```

Switch to a different model preset. Reloads models automatically.

**Request Body**:
```json
{
  "presetId": "quality"
}
```

**Response**:
```json
{
  "success": true,
  "activePreset": "quality",
  "capabilities": {
    "bm25": true,
    "vector": true,
    "hybrid": true,
    "answer": true
  }
}
```

**Example**:
```bash
curl -X POST http://localhost:3000/api/presets \
  -H "Content-Type: application/json" \
  -d '{"presetId": "quality"}'
```

---

### Model Download Status

```http
GET /api/models/status
```

Check the status of model downloads.

**Response**:
```json
{
  "active": true,
  "currentType": "embed",
  "progress": {
    "downloadedBytes": 104857600,
    "totalBytes": 524288000,
    "percent": 20
  },
  "completed": [],
  "failed": [],
  "startedAt": 1706000000000
}
```

| Field | Description |
|:------|:------------|
| `active` | Whether download is in progress |
| `currentType` | Current model: `embed`, `gen`, or `rerank` |
| `progress` | Download progress for current model |
| `completed` | Successfully downloaded model types |
| `failed` | Failed downloads with error messages |

---

### Start Model Download

```http
POST /api/models/pull
```

Start downloading models for the active preset. Returns immediately and downloads in background. Poll `/api/models/status` for progress.

**Response**:
```json
{
  "started": true,
  "message": "Download started. Poll /api/models/status for progress."
}
```

**Error** (download already in progress):
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Download already in progress"
  }
}
```

**Example**:
```bash
# Start download
curl -X POST http://localhost:3000/api/models/pull

# Poll status until complete
while true; do
  curl -s http://localhost:3000/api/models/status | jq
  sleep 2
done
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Missing or invalid query"
  }
}
```

| Code | HTTP Status | Description |
|:-----|:------------|:------------|
| `VALIDATION` | 400 | Invalid request parameters |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Operation already in progress |
| `UNAVAILABLE` | 503 | Feature not available (model not loaded) |
| `RUNTIME` | 500 | Internal error |

---

## Usage Examples

### Search from a Script

```bash
#!/bin/bash
# search.sh - Search GNO from command line

QUERY="$1"
curl -s -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$QUERY\", \"limit\": 5}" \
  | jq -r '.results[] | "\(.score | tostring | .[0:4]) \(.title)"'
```

### Python Integration

```python
import requests

def search_gno(query: str, limit: int = 10) -> list:
    """Search GNO index."""
    resp = requests.post(
        "http://localhost:3000/api/query",
        json={"query": query, "limit": limit}
    )
    resp.raise_for_status()
    return resp.json()["results"]

def ask_gno(question: str) -> str:
    """Get AI answer from GNO."""
    resp = requests.post(
        "http://localhost:3000/api/ask",
        json={"query": question}
    )
    resp.raise_for_status()
    return resp.json().get("answer", "No answer generated")

# Usage
results = search_gno("authentication patterns")
answer = ask_gno("What is our deployment process?")
```

### JavaScript/TypeScript

```typescript
async function searchGno(query: string): Promise<SearchResult[]> {
  const resp = await fetch("http://localhost:3000/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 10 }),
  });
  const data = await resp.json();
  return data.results;
}

async function askGno(question: string): Promise<string> {
  const resp = await fetch("http://localhost:3000/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question }),
  });
  const data = await resp.json();
  return data.answer ?? "No answer generated";
}
```

### Raycast Script Command

```bash
#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Search Notes
# @raycast.mode fullOutput
# @raycast.argument1 { "type": "text", "placeholder": "Query" }

curl -s -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"$1\", \"limit\": 5}" \
  | jq -r '.results[] | "• \(.title)\n  \(.chunk.text | .[0:100])...\n"'
```

---

## Rate Limits

None. The API runs locally with no rate limiting. Performance depends on your hardware and model configuration.

---

## See Also

- [Web UI Guide](./WEB-UI.md) — Visual interface documentation
- [CLI Reference](./CLI.md) — Command-line interface
- [MCP Integration](./MCP.md) — AI assistant integration
